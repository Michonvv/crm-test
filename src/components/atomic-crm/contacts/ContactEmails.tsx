import { Mail } from "lucide-react";
import { useDataProvider, useRecordContext, useGetIdentity } from "ra-core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Contact } from "../types";
import type { CrmDataProvider } from "../providers/types";
import { RelativeDate } from "../misc/RelativeDate";
import { EmailFormattedText } from "../notes/EmailFormattedText";
import { ZohoMailConnect } from "./ZohoMailConnect";
import { supabase } from "../providers/supabase/supabase";

/**
 * Decode HTML entities in a string
 * Handles entities like &quot;, &lt;, &gt;, &amp;, etc.
 * Uses browser's built-in decoder for reliability
 */
function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  
  // Use browser's built-in HTML entity decoder
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  let decoded = textarea.value;
  
  // Fallback for cases where textarea doesn't work (shouldn't happen in browser)
  if (decoded === text) {
    // Manual decoding as fallback
    const entityMap: Record<string, string> = {
      '&quot;': '"',
      '&apos;': "'",
      '&lt;': '<',
      '&gt;': '>',
      '&amp;': '&',
      '&#39;': "'",
      '&#x27;': "'",
      '&#x2F;': '/',
    };
    
    // Decode numeric entities
    decoded = decoded.replace(/&#(\d+);/g, (match, dec) => {
      return String.fromCharCode(parseInt(dec, 10));
    });
    
    // Decode hex entities
    decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/gi, (match, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
    
    // Decode named entities
    decoded = decoded.replace(/&([a-z]+);/gi, (match) => {
      return entityMap[match.toLowerCase()] || match;
    });
  }
  
  return decoded;
}

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
  const [showAll, setShowAll] = useState(false);

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
    queryFn: async () => {
      const result = await dataProvider.getContactEmails(record.id);
      // Debug: Log what we received
      console.log(`Fetched ${result.count} emails. Sample email:`, result.emails[0] ? {
        hasContent: !!result.emails[0].content,
        hasText: !!(result.emails[0].content?.text),
        hasHtml: !!(result.emails[0].content?.html),
        textLength: result.emails[0].content?.text?.length || 0,
        htmlLength: result.emails[0].content?.html?.length || 0,
        snippet: result.emails[0].snippet?.substring(0, 50),
      } : 'no emails');
      return result;
    },
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

  // Show only first 3 emails initially, then all when "See more" is clicked
  const displayedEmails = showAll ? data.emails : data.emails.slice(0, 3);
  const hasMoreEmails = data.emails.length > 3;

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-4">
        <Mail className="w-5 h-5 text-muted-foreground" />
        <h6 className="text-sm font-semibold">Emails ({data.count})</h6>
      </div>
      <div className="space-y-4">
        {displayedEmails.map((email, index) => {
          // Decode HTML entities in subject, from, and to fields
          const decodedSubject = decodeHtmlEntities(email.subject || "(No subject)");
          const decodedFromName = decodeHtmlEntities(email.from.name || "");
          const decodedFromEmail = decodeHtmlEntities(email.from.email || "");
          const decodedTo = email.to.map(recipient => ({
            name: decodeHtmlEntities(recipient.name || ""),
            email: decodeHtmlEntities(recipient.email || ""),
          }));

          // Decode content - both text and HTML may contain entities
          let decodedContent = email.content;
          if (email.content) {
            decodedContent = {
              text: email.content.text ? decodeHtmlEntities(email.content.text) : "",
              html: email.content.html ? decodeHtmlEntities(email.content.html) : "",
            };
          }

          return (
            <div key={email.messageId}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium truncate">
                      {decodedSubject}
                    </span>
                    {email.hasAttachments && (
                      <span className="text-xs text-muted-foreground">📎</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mb-2">
                    <span className="font-medium">
                      {decodedFromName || decodedFromEmail}
                    </span>
                    {decodedTo.length > 0 && (
                      <>
                        {" → "}
                        {decodedTo
                          .map((recipient) => recipient.name || recipient.email)
                          .join(", ")}
                      </>
                    )}
                  </div>
                  {/* Display email content - check if we have actual content, not just empty strings */}
                  {decodedContent && (decodedContent.html || decodedContent.text) ? (
                    // Display full content if available (prefer HTML, fallback to text)
                    <div className="text-sm text-muted-foreground mt-2">
                      {decodedContent.html ? (
                        <div 
                          className="email-html-content max-w-full overflow-auto border rounded-md p-3 bg-muted/30 max-h-96"
                          dangerouslySetInnerHTML={{ __html: decodedContent.html }}
                          style={{
                            // Limit styles to prevent email styling from breaking layout
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                            // Contain email styles
                            maxWidth: '100%',
                            // Sanitize email styles to prevent layout issues
                            fontSize: 'inherit',
                            fontFamily: 'inherit',
                          }}
                        />
                      ) : decodedContent.text ? (
                        <div className="border rounded-md p-3 bg-muted/30 max-h-96 overflow-auto whitespace-pre-wrap">
                          <EmailFormattedText text={decodedContent.text} />
                        </div>
                      ) : null}
                    </div>
                  ) : email.snippet ? (
                    // Fallback to snippet if content not available (show full snippet, not truncated)
                    <div className="text-sm text-muted-foreground mt-2 border rounded-md p-3 bg-muted/30">
                      <EmailFormattedText text={decodeHtmlEntities(email.snippet)} />
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground mt-2 italic">
                      No content available
                    </div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                  <RelativeDate date={email.date} />
                </div>
              </div>
              {index < displayedEmails.length - 1 && (
                <Separator className="mt-4" />
              )}
            </div>
          );
        })}
      </div>
      {hasMoreEmails && !showAll && (
        <div className="mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAll(true)}
            className="w-full"
          >
            See more emails ({data.emails.length - 3} more)
          </Button>
        </div>
      )}
      {showAll && hasMoreEmails && (
        <div className="mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAll(false)}
            className="w-full"
          >
            Show less
          </Button>
        </div>
      )}
    </div>
  );
};

