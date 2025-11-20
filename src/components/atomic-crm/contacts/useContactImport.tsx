import { useDataProvider, useGetIdentity, type DataProvider } from "ra-core";
import { useCallback, useMemo } from "react";

import type { Company, Tag } from "../types";

export type ContactImportSchema = {
  first_name?: string;
  last_name?: string;
  gender?: string;
  title?: string;
  company?: string;
  email_work?: string;
  email_home?: string;
  email_other?: string;
  phone_work?: string;
  phone_home?: string;
  phone_other?: string;
  background?: string;
  avatar?: string;
  first_seen?: string;
  last_seen?: string;
  has_newsletter?: string;
  status?: string;
  tags?: string;
  linkedin_url?: string;
  // Zoho CSV column names (and other common variations)
  "First Name"?: string;
  "Middle Name"?: string;
  "Last Name"?: string;
  "Nick Name"?: string;
  Email?: string;
  Category?: string;
  Mobile?: string;
  "Home Phone"?: string;
  "Work Phone"?: string;
  Fax?: string;
  "Other Phone"?: string;
  Gender?: string;
  "Birth Day"?: string;
  "Birth Month"?: string;
  "Birth Year"?: string;
  "Company Name"?: string;
  Designation?: string;
  "Work Address"?: string;
  "Work Address1"?: string;
  "Work City"?: string;
  "Work State"?: string;
  "Work Zip/Postal Code"?: string;
  "Work Country"?: string;
  Address?: string;
  Address1?: string;
  City?: string;
  State?: string;
  "Zip/Postal Code"?: string;
  Country?: string;
  "LinkedIn URL"?: string;
  Notes?: string;
};

// Normalize CSV data from various formats (Zoho, etc.) to expected schema
function normalizeContactImport(
  rawData: Record<string, any>,
): ContactImportSchema {
  // Helper to get value with fallback to multiple possible keys
  const getValue = (...keys: string[]): string => {
    for (const key of keys) {
      const value = rawData[key];
      if (value !== undefined && value !== null && value !== "") {
        return String(value);
      }
    }
    return "";
  };

  // Get raw values first
  let firstName = getValue("first_name", "First Name");
  let lastName = getValue("last_name", "Last Name");

  // If last_name is empty but first_name contains spaces, split it
  if (!lastName && firstName && firstName.includes(" ")) {
    const nameParts = firstName.trim().split(/\s+/);
    if (nameParts.length > 1) {
      firstName = nameParts[0];
      lastName = nameParts.slice(1).join(" ");
    }
  }

  // Map Zoho and other common CSV formats to expected schema
  const normalized: ContactImportSchema = {
    first_name: firstName,
    last_name: lastName,
    gender: getValue("gender", "Gender"),
    title: getValue("title", "Designation"),
    company: getValue("company", "Company Name"),
    email_work: getValue("email_work", "Email"), // Zoho's "Email" goes to work email
    email_home: getValue("email_home"),
    email_other: getValue("email_other"),
    phone_work: getValue("phone_work", "Work Phone", "Mobile"), // Mobile often means work phone
    phone_home: getValue("phone_home", "Home Phone"),
    phone_other: getValue("phone_other", "Other Phone", "Fax"),
    background: getValue("background", "Notes"),
    avatar: getValue("avatar"),
    first_seen: getValue("first_seen"),
    last_seen: getValue("last_seen"),
    has_newsletter: getValue("has_newsletter"),
    status: getValue("status"),
    tags: getValue("tags", "Category"), // Zoho's "Category" can be used as tags
    linkedin_url: getValue("linkedin_url", "LinkedIn URL"),
  };

  return normalized;
}

export function useContactImport() {
  const today = new Date().toISOString();
  const user = useGetIdentity();
  const dataProvider = useDataProvider();

  // company cache to avoid creating the same company multiple times and costly roundtrips
  // Cache is dependent of dataProvider, so it's safe to use it as a dependency
  const companiesCache = useMemo(
    () => new Map<string, Company>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataProvider],
  );
  const getCompanies = useCallback(
    async (names: string[]) =>
      fetchRecordsWithCache<Company>(
        "companies",
        companiesCache,
        names,
        (name) => ({
          name,
          created_at: new Date().toISOString(),
          sales_id: user?.identity?.id,
        }),
        dataProvider,
      ),
    [companiesCache, user?.identity?.id, dataProvider],
  );

  // Tags cache to avoid creating the same tag multiple times and costly roundtrips
  // Cache is dependent of dataProvider, so it's safe to use it as a dependency
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tagsCache = useMemo(() => new Map<string, Tag>(), [dataProvider]);
  const getTags = useCallback(
    async (names: string[]) =>
      fetchRecordsWithCache<Tag>(
        "tags",
        tagsCache,
        names,
        (name) => ({
          name,
          color: "#f9f9f9",
        }),
        dataProvider,
      ),
    [tagsCache, dataProvider],
  );

  const processBatch = useCallback(
    async (batch: ContactImportSchema[]) => {
      // Normalize the batch data to handle different CSV formats
      const normalizedBatch = batch
        .map(normalizeContactImport)
        // Filter out rows that don't have at least a first name or email
        .filter(
          (contact) =>
            (contact.first_name && contact.first_name.trim()) ||
            (contact.email_work && contact.email_work.trim()) ||
            (contact.email_home && contact.email_home.trim()) ||
            (contact.email_other && contact.email_other.trim()),
        );

      if (normalizedBatch.length === 0) {
        return;
      }

      const [companies, tags] = await Promise.all([
        getCompanies(
          normalizedBatch
            .map((contact) => contact.company?.trim())
            .filter((name) => name),
        ),
        getTags(normalizedBatch.flatMap((batch) => parseTags(batch.tags || ""))),
      ]);

      await Promise.all(
        normalizedBatch.map(
          async ({
            first_name,
            last_name,
            gender,
            title,
            email_work,
            email_home,
            email_other,
            phone_work,
            phone_home,
            phone_other,
            background,
            first_seen,
            last_seen,
            has_newsletter,
            status,
            company: companyName,
            tags: tagNames,
            linkedin_url,
          }) => {
            const email_jsonb = [
              { email: email_work, type: "Work" },
              { email: email_home, type: "Home" },
              { email: email_other, type: "Other" },
            ].filter(({ email }) => email);
            const phone_jsonb = [
              { number: phone_work, type: "Work" },
              { number: phone_home, type: "Home" },
              { number: phone_other, type: "Other" },
            ].filter(({ number }) => number);
            const company = companyName?.trim()
              ? companies.get(companyName.trim())
              : undefined;
            const tagList = parseTags(tagNames || "")
              .map((name) => tags.get(name))
              .filter((tag): tag is Tag => !!tag);

            // Convert has_newsletter from string to boolean
            const hasNewsletterBoolean =
              has_newsletter === "true" ||
              has_newsletter === "1" ||
              has_newsletter === "yes" ||
              has_newsletter === true;

            return dataProvider.create("contacts", {
              data: {
                first_name,
                last_name,
                gender,
                title,
                email_jsonb,
                phone_jsonb,
                background,
                first_seen: first_seen
                  ? new Date(first_seen).toISOString()
                  : today,
                last_seen: last_seen
                  ? new Date(last_seen).toISOString()
                  : today,
                has_newsletter: hasNewsletterBoolean,
                status,
                company_id: company?.id,
                tags: tagList.map((tag) => tag.id),
                sales_id: user?.identity?.id,
                linkedin_url,
              },
            });
          },
        ),
      );
    },
    [dataProvider, getCompanies, getTags, user?.identity?.id, today],
  );

  return processBatch;
}

const fetchRecordsWithCache = async function <T>(
  resource: string,
  cache: Map<string, T>,
  names: string[],
  getCreateData: (name: string) => Partial<T>,
  dataProvider: DataProvider,
) {
  const trimmedNames = [...new Set(names.map((name) => name.trim()))];
  const uncachedRecordNames = trimmedNames.filter((name) => !cache.has(name));

  // check the backend for existing records
  if (uncachedRecordNames.length > 0) {
    const response = await dataProvider.getList(resource, {
      filter: {
        "name@in": `(${uncachedRecordNames
          .map((name) => `"${name}"`)
          .join(",")})`,
      },
      pagination: { page: 1, perPage: trimmedNames.length },
      sort: { field: "id", order: "ASC" },
    });
    for (const record of response.data) {
      cache.set(record.name.trim(), record);
    }
  }

  // create missing records in parallel
  await Promise.all(
    uncachedRecordNames.map(async (name) => {
      if (cache.has(name)) return;
      const response = await dataProvider.create(resource, {
        data: getCreateData(name),
      });
      cache.set(name, response.data);
    }),
  );

  // now all records are in cache, return a map of all records
  return trimmedNames.reduce((acc, name) => {
    acc.set(name, cache.get(name) as T);
    return acc;
  }, new Map<string, T>());
};

const parseTags = (tags: string) =>
  tags
    ?.split(",")
    ?.map((tag: string) => tag.trim())
    ?.filter((tag: string) => tag) ?? [];
