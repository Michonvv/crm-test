import { Mail } from "lucide-react";
import { useDataProvider, useRecordContext, useGetIdentity } from "ra-core";
import { useQuery } from "@tanstack/react-query";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { Contact } from "../types";
import type { CrmDataProvider } from "../providers/types";
import { RelativeDate } from "../misc/RelativeDate";
import { EmailFormattedText } from "../notes/EmailFormattedText";
import { ZohoMailConnect } from "./ZohoMailConnect";
import { supabase } from "../providers/supabase/supabase";

interface ZohoEmail {
  messageId: string;
  folderId: string;
  subject: string;
  from: { email: string; name: string };
  to: Array<{ email: string; name: string }>;
  cc?: Array<{ email: string; name: string }>;
  date: string;
  snippet: string;
  hasAttachments: boolean;
  content?: { text: string; html: string };
}

interface ContactEmailsResponse {
  emails: ZohoEmail[];
  count: number;
}

export const ContactEmails = () => {
  const record = useRecordContext<Contact>();
  const dataProvider = useDataProvider<CrmDataProvider>();
  const { identity } = useGetIdentity();

  if (!record) return null;

  // Extract email addresses from contact
  const contactEmails =
    record.email_jsonb
      ?.map((email) => email.email)
      .filter((email) => email && email.trim()) || [];

  // Check if user has Zoho Mail connected
  // identity.id is already the sales_id (from authProvider.getIdentity)
  const { data: zohoToken, isLoading: checkingToken, error: tokenError } = useQuery({
    queryKey: ["zohoToken", identity?.id],
    queryFn: async () => {
      if (!identity?.id) return null;

      const { data, error } = await supabase
        .from("zoho_oauth_tokens")
        .select("*")
        .eq("sales_id", identity.id)
        .maybeSingle(); // Use maybeSingle() instead of single() to handle no record gracefully
      
      if (error && error.code !== 'PGRST116') { // PGRST116 is "no rows returned"
        console.error("Error fetching Zoho token:", error);
        return null;
      }
      
      return data;
    },
    enabled: !!identity?.id,
    retry: false, // Don't retry if no token found
  });

  // Only fetch if contact has email addresses and Zoho is connected
  const { data, isPending, error } = useQuery<ContactEmailsResponse>({
    queryKey: ["contactEmails", record.id],
    queryFn: () => dataProvider.getContactEmails(record.id),
    enabled: contactEmails.length > 0 && !!zohoToken && !checkingToken,
  });

  // Don't show anything if contact has no emails
  if (contactEmails.length === 0) {
    return null;
  }

  // Show connect button if not connected
  if (!checkingToken && !zohoToken) {
    console.log("Zoho Mail not connected. Token check:", { checkingToken, zohoToken, tokenError, identityId: identity?.id });
    return <ZohoMailConnect />;
  }

  // Debug log
  if (zohoToken) {
    console.log("Zoho Mail connected. Token found:", { hasToken: !!zohoToken, salesId: identity?.id });
  }

  if (isPending || checkingToken) {
    return (
      <div className="mt-4">
        <div className="flex items-center gap-2 mb-4">
          <Mail className="w-5 h-5 text-muted-foreground" />
          <h6 className="text-sm font-semibold">Emails</h6>
        </div>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="w-full h-4" />
              <Skeleton className="w-3/4 h-3" />
              <Skeleton className="w-1/2 h-3" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4">
        <div className="flex items-center gap-2 mb-4">
          <Mail className="w-5 h-5 text-muted-foreground" />
          <h6 className="text-sm font-semibold">Emails</h6>
        </div>
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load emails. Please check your Zoho Mail API configuration.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!data || data.count === 0) {
    return (
      <div className="mt-4">
        <div className="flex items-center gap-2 mb-4">
          <Mail className="w-5 h-5 text-muted-foreground" />
          <h6 className="text-sm font-semibold">Emails</h6>
        </div>
        <p className="text-sm text-muted-foreground">
          No emails found for this contact.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-4">
        <Mail className="w-5 h-5 text-muted-foreground" />
        <h6 className="text-sm font-semibold">Emails ({data.count})</h6>
      </div>
      <div className="space-y-4">
        {data.emails.map((email, index) => (
          <div key={email.messageId}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium truncate">
                    {email.subject || "(No subject)"}
                  </span>
                  {email.hasAttachments && (
                    <span className="text-xs text-muted-foreground">📎</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mb-2">
                  <span className="font-medium">
                    {email.from.name || email.from.email}
                  </span>
                  {email.to.length > 0 && (
                    <>
                      {" → "}
                      {email.to
                        .map((recipient) => recipient.name || recipient.email)
                        .join(", ")}
                    </>
                  )}
                </div>
                {email.snippet && (
                  <div className="text-sm text-muted-foreground line-clamp-2">
                    <EmailFormattedText text={email.snippet} />
                  </div>
                )}
              </div>
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                <RelativeDate date={email.date} />
              </div>
            </div>
            {index < data.emails.length - 1 && (
              <Separator className="mt-4" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

