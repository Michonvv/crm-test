// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, createErrorResponse } from "../_shared/utils.ts";

// Zoho Mail API configuration (for OAuth token refresh only)
const ZOHO_CLIENT_ID = Deno.env.get("ZOHO_CLIENT_ID");
const ZOHO_CLIENT_SECRET = Deno.env.get("ZOHO_CLIENT_SECRET");

// Zoho API base URLs by data center
const ZOHO_API_BASE_URLS: Record<string, string> = {
  us: "https://mail.zoho.com/api",
  eu: "https://mail.zoho.eu/api",
  in: "https://mail.zoho.in/api",
  au: "https://mail.zoho.com.au/api",
  jp: "https://mail.zoho.jp/api",
};

const ZOHO_TOKEN_URLS: Record<string, string> = {
  us: "https://accounts.zoho.com/oauth/v2/token",
  eu: "https://accounts.zoho.eu/oauth/v2/token",
  in: "https://accounts.zoho.in/oauth/v2/token",
  au: "https://accounts.zoho.com.au/oauth/v2/token",
  jp: "https://accounts.zoho.jp/oauth/v2/token",
};

// Note: Tokens are now stored per-user in the database, not cached here

interface ZohoTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface ZohoEmailSearchResponse {
  data?: {
    messages?: Array<{
      messageId: string;
      folderId: string;
      subject: string;
      from: { email: string; name: string };
      to: Array<{ email: string; name: string }>;
      cc?: Array<{ email: string; name: string }>;
      date: string;
      snippet: string;
      hasAttachments: boolean;
    }>;
    hasMore?: boolean;
  };
  messages?: Array<{
    messageId: string;
    folderId: string;
    subject: string;
    from: { email: string; name: string };
    to: Array<{ email: string; name: string }>;
    cc?: Array<{ email: string; name: string }>;
    date: string;
    snippet: string;
    hasAttachments: boolean;
  }>;
}

interface ZohoEmailContentResponse {
  data: {
    content: {
      text: string;
      html: string;
    };
  };
}

/**
 * Refresh Zoho OAuth access token for a user
 */
async function refreshUserAccessToken(
  refreshToken: string,
  dataCenter: string = "eu",
): Promise<ZohoTokenResponse> {
  const ZOHO_CLIENT_ID = Deno.env.get("ZOHO_CLIENT_ID");
  const ZOHO_CLIENT_SECRET = Deno.env.get("ZOHO_CLIENT_SECRET");
  
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
    throw new Error(
      "Missing Zoho OAuth configuration. Please set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET environment variables.",
    );
  }

  const tokenUrl = ZOHO_TOKEN_URLS[dataCenter] || ZOHO_TOKEN_URLS.us;
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Zoho token: ${errorText}`);
  }

  return await response.json();
}

// Removed getAccessToken - now using user-specific tokens from database

/**
 * Get all accounts from Zoho Mail API (using user's access token)
 * According to Zoho Mail API docs: GET /api/accounts
 * Response format: { "data": [{ "accountId": "...", "accountDisplayName": "..." }] }
 */
async function getAllAccounts(accessToken: string, apiBaseUrl: string): Promise<Array<{ accountId: string; accountDisplayName: string }>> {
  try {
    const accountsUrl = `${apiBaseUrl}/accounts`;
    console.log(`Fetching all accounts from: ${accountsUrl}`);
    
    const response = await fetch(accountsUrl, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      const data: any = await response.json();
      console.log(`Accounts API response:`, JSON.stringify(data, null, 2));
      
      // According to Zoho Mail API docs, response is: { "data": [{ "accountId": "...", "accountDisplayName": "..." }] }
      if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
        const accounts = data.data.map((acc: any) => ({
          accountId: acc.accountId || acc.id || acc.account_id,
          accountDisplayName: acc.accountDisplayName || acc.displayName || acc.email || acc.account_email,
        })).filter((acc: any) => acc.accountId);
        
        console.log(`Found ${accounts.length} account(s):`, accounts);
        return accounts;
      }
      
      // Fallback: try other response structures
      if (data?.accounts && Array.isArray(data.accounts) && data.accounts.length > 0) {
        const accounts = data.accounts.map((acc: any) => ({
          accountId: acc.accountId || acc.id || acc.account_id,
          accountDisplayName: acc.accountDisplayName || acc.displayName || acc.email || acc.account_email,
        })).filter((acc: any) => acc.accountId);
        
        console.log(`Found ${accounts.length} account(s) (fallback):`, accounts);
        return accounts;
      }
    } else {
      const errorText = await response.text();
      console.warn(`Failed to get accounts: ${response.status} - ${errorText}`);
    }
  } catch (error) {
    console.error(`Error getting accounts:`, error);
  }
  
  return [];
}

/**
 * Get account ID from Zoho Mail API (using user's access token)
 * First tries to use stored account_id, otherwise fetches from API
 */
async function getAccountId(
  accessToken: string, 
  apiBaseUrl: string, 
  storedAccountId?: string | null
): Promise<string | null> {
  // If we have a stored account ID, use it
  if (storedAccountId) {
    console.log(`Using stored account ID: ${storedAccountId}`);
    return storedAccountId;
  }
  
  // Otherwise, fetch accounts from API
  const accounts = await getAllAccounts(accessToken, apiBaseUrl);
  
  if (accounts.length > 0) {
    // Return the first account ID (primary account)
    const accountId = accounts[0].accountId;
    console.log(`Retrieved account ID from API: ${accountId}`);
    return accountId;
  }
  
  return null;
}

/**
 * Get folder ID by name (e.g., "Inbox", "Sent")
 */
async function getFolderId(
  folderName: string,
  accessToken: string,
  apiBaseUrl: string,
  accountId: string,
): Promise<string | null> {
  try {
    const foldersUrl = `${apiBaseUrl}/accounts/${accountId}/folders`;
    const response = await fetch(foldersUrl, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      const data: any = await response.json();
      const folders = data?.data?.folders || data?.folders || data?.data || [];
      
      const folder = folders.find((f: any) => 
        f.name?.toLowerCase() === folderName.toLowerCase() ||
        f.folderName?.toLowerCase() === folderName.toLowerCase()
      );
      
      return folder?.folderId || folder?.id || folder?.folder_id || null;
    }
  } catch (error) {
    console.error(`Error getting folder ${folderName}:`, error);
  }
  
  return null;
}

/**
 * Search emails by contact email addresses across all accounts
 */
async function searchEmailsByContact(
  contactEmails: string[],
  limit: number = 50,
  accessToken: string,
  apiBaseUrl: string,
  accountId: string,
): Promise<any[]> {
  const allMessages: any[] = [];
  
  // Normalize email addresses (lowercase, trim)
  const normalizedEmails = contactEmails.map(email => email.toLowerCase().trim()).filter(Boolean);
  
  if (normalizedEmails.length === 0) {
    console.warn("No valid email addresses to search");
    return [];
  }
  
  if (!accountId) {
    console.error("Account ID is required for email search");
    return [];
  }
  
  console.log(`Using account ID: ${accountId}`);
  console.log(`Searching for emails with addresses: ${normalizedEmails.join(", ")}`);

  // Get folder IDs for Inbox and Sent (common folders) - only if needed for folder-specific search
  let inboxFolderId: string | null = null;
  let sentFolderId: string | null = null;

  // Search for emails where contact is sender or recipient
  // According to Zoho Mail API docs, we need accountId for search
  // Endpoint: GET /api/accounts/{accountId}/messages/search?searchKey={contact_email}
  
  if (!accountId) {
    console.error("Cannot search emails: Account ID is required but not available");
    return [];
  }
  
  for (const email of normalizedEmails) {
    try {
      // According to Zoho Mail API docs: https://www.zoho.com/mail/help/api/get-search-emails.html
      // searchKey uses search syntax like "from:email@example.com" or "to:email@example.com"
      // We'll search for emails where the contact is sender OR recipient
      
      // Approach 1: Search for emails FROM this contact
      const fromSearchKey = `from:${email}`;
      const fromSearchUrl = `${apiBaseUrl}/accounts/${accountId}/messages/search?searchKey=${encodeURIComponent(fromSearchKey)}&limit=${limit}&includeto=true`;

      console.log(`Searching emails FROM: ${email}`, fromSearchUrl);
      const fromResponse = await fetch(fromSearchUrl, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (fromResponse.ok) {
        const fromData: any = await fromResponse.json();
        console.log(`FROM search response:`, JSON.stringify(fromData, null, 2));
        
        // According to Zoho Mail API docs, response structure is:
        // { "status": { "code": 200, "description": "success" }, "data": [...] }
        let messages: any[] = [];
        if (fromData?.data && Array.isArray(fromData.data)) {
          messages = fromData.data;
        }
        
        if (messages.length > 0) {
          // Filter to ensure emails actually match the contact email
          const filteredMessages = messages.filter((msg: any) => {
            const fromAddr = (msg.fromAddress || msg.from?.email || msg.from || "").toLowerCase();
            return fromAddr === email.toLowerCase();
          });
          console.log(`Found ${messages.length} messages FROM ${email}, filtered to ${filteredMessages.length} matching messages`);
          allMessages.push(...filteredMessages);
        }
      } else {
        const errorText = await fromResponse.text();
        console.warn(`FROM search failed for ${email}: ${fromResponse.status} - ${errorText.substring(0, 200)}`);
      }
      
      // Approach 2: Search for emails TO this contact
      const toSearchKey = `to:${email}`;
      const toSearchUrl = `${apiBaseUrl}/accounts/${accountId}/messages/search?searchKey=${encodeURIComponent(toSearchKey)}&limit=${limit}&includeto=true`;

      console.log(`Searching emails TO: ${email}`, toSearchUrl);
      const toResponse = await fetch(toSearchUrl, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (toResponse.ok) {
        const toData: any = await toResponse.json();
        console.log(`TO search response:`, JSON.stringify(toData, null, 2));
        
        let messages: any[] = [];
        if (toData?.data && Array.isArray(toData.data)) {
          messages = toData.data;
        }
        
        if (messages.length > 0) {
          // Filter to ensure emails actually match the contact email in TO field
          // Need includeto=true to get toAddress field
          const filteredMessages = messages.filter((msg: any) => {
            // Check toAddress field (array or string)
            const toAddresses = msg.toAddress || msg.to || [];
            const toArray = Array.isArray(toAddresses) ? toAddresses : [toAddresses];
            return toArray.some((addr: any) => {
              const addrEmail = (typeof addr === 'string' ? addr : addr.email || "").toLowerCase();
              return addrEmail === email.toLowerCase();
            });
          });
          console.log(`Found ${messages.length} messages TO ${email}, filtered to ${filteredMessages.length} matching messages`);
          allMessages.push(...filteredMessages);
        }
      } else {
        const errorText = await toResponse.text();
        console.warn(`TO search failed for ${email}: ${toResponse.status} - ${errorText.substring(0, 200)}`);
      }
      
      // Approach 3: Try searching for emails where contact is in CC
      const ccSearchKey = `cc:${email}`;
      const ccSearchUrl = `${apiBaseUrl}/accounts/${accountId}/messages/search?searchKey=${encodeURIComponent(ccSearchKey)}&limit=${limit}&includeto=true`;

      console.log(`Searching emails CC: ${email}`, ccSearchUrl);
      const ccResponse = await fetch(ccSearchUrl, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (ccResponse.ok) {
        const ccData: any = await ccResponse.json();
        let messages: any[] = [];
        if (ccData?.data && Array.isArray(ccData.data)) {
          messages = ccData.data;
        }
        
        if (messages.length > 0) {
          // Filter to ensure emails actually match the contact email in CC field
          const filteredMessages = messages.filter((msg: any) => {
            const ccAddresses = msg.ccAddress || msg.cc || [];
            const ccArray = Array.isArray(ccAddresses) ? ccAddresses : [ccAddresses];
            return ccArray.some((addr: any) => {
              const addrEmail = (typeof addr === 'string' ? addr : addr.email || "").toLowerCase();
              return addrEmail === email.toLowerCase();
            });
          });
          console.log(`Found ${messages.length} messages CC ${email}, filtered to ${filteredMessages.length} matching messages`);
          allMessages.push(...filteredMessages);
        }
      }

      // Approach 4: Search in specific folders (Inbox and Sent) if general search didn't find much
      // Only fetch folder IDs if we need them
      if (allMessages.length < 5) {
        if (!inboxFolderId) {
          inboxFolderId = await getFolderId("Inbox", accessToken, apiBaseUrl, accountId);
        }
        if (!sentFolderId) {
          sentFolderId = await getFolderId("Sent", accessToken, apiBaseUrl, accountId);
        }
        
        if (inboxFolderId || sentFolderId) {
          const foldersToSearch = [
            { id: inboxFolderId, name: "Inbox" },
            { id: sentFolderId, name: "Sent" },
          ].filter(f => f.id);

          for (const folder of foldersToSearch) {
            // Search in folder using searchKey with proper syntax
            const folderFromSearch = `from:${email}`;
            const folderFromUrl = `${apiBaseUrl}/accounts/${accountId}/folders/${folder.id}/messages/search?searchKey=${encodeURIComponent(folderFromSearch)}&limit=${limit}&includeto=true`;
            console.log(`Searching in ${folder.name} folder FROM: ${email}`, folderFromUrl);
            
            const folderFromResponse = await fetch(folderFromUrl, {
              headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
                "Content-Type": "application/json",
              },
            });

            if (folderFromResponse.ok) {
              const folderData: any = await folderFromResponse.json();
              let messages: any[] = [];
              
              if (folderData?.data && Array.isArray(folderData.data)) {
                messages = folderData.data;
              }
              
              if (messages.length > 0) {
                console.log(`Found ${messages.length} messages in ${folder.name} FROM ${email}`);
                allMessages.push(...messages);
              }
            }
            
            // Also search for emails TO this contact in the folder
            const folderToSearch = `to:${email}`;
            const folderToUrl = `${apiBaseUrl}/accounts/${accountId}/folders/${folder.id}/messages/search?searchKey=${encodeURIComponent(folderToSearch)}&limit=${limit}&includeto=true`;
            console.log(`Searching in ${folder.name} folder TO: ${email}`, folderToUrl);
            
            const folderToResponse = await fetch(folderToUrl, {
              headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
                "Content-Type": "application/json",
              },
            });

            if (folderToResponse.ok) {
              const folderData: any = await folderToResponse.json();
              let messages: any[] = [];
              
              if (folderData?.data && Array.isArray(folderData.data)) {
                messages = folderData.data;
              }
              
              if (messages.length > 0) {
                console.log(`Found ${messages.length} messages in ${folder.name} TO ${email}`);
                allMessages.push(...messages);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error searching emails for ${email}:`, error);
    }
  }
  
  console.log(`Total messages found before filtering: ${allMessages.length}`);

  // Final filter: Ensure all messages actually match one of the contact emails
  // This is important because the searchKey might not be filtering correctly
  const contactEmailSet = new Set(normalizedEmails);
  const filteredMessages = allMessages.filter((msg: any) => {
    // Check FROM field
    const fromAddr = (msg.fromAddress || msg.from?.email || msg.from || "").toLowerCase().trim();
    if (contactEmailSet.has(fromAddr)) {
      return true;
    }
    
    // Check TO field (need to handle array)
    const toAddresses = msg.toAddress || msg.to || [];
    const toArray = Array.isArray(toAddresses) ? toAddresses : [toAddresses];
    for (const addr of toArray) {
      const addrEmail = (typeof addr === 'string' ? addr : (addr.email || addr.address || "")).toLowerCase().trim();
      if (contactEmailSet.has(addrEmail)) {
        return true;
      }
    }
    
    // Check CC field
    const ccAddresses = msg.ccAddress || msg.cc || [];
    const ccArray = Array.isArray(ccAddresses) ? ccAddresses : [ccAddresses];
    for (const addr of ccArray) {
      const addrEmail = (typeof addr === 'string' ? addr : (addr.email || addr.address || "")).toLowerCase().trim();
      if (contactEmailSet.has(addrEmail)) {
        return true;
      }
    }
    
    return false;
  });
  
  console.log(`Total messages after filtering: ${filteredMessages.length}`);

  // Remove duplicates based on messageId (handle different ID field names and formats)
  const uniqueMessages = Array.from(
    new Map(
      filteredMessages.map((msg) => {
        // messageId can be a number or string, normalize it
        const msgId = String(msg.messageId || msg.id || msg.message_id || "");
        return [msgId || JSON.stringify(msg), msg];
      })
    ).values(),
  );

  // Sort by date (newest first) - handle different date field names
  // API returns receivedtime as Unix timestamp in milliseconds
  uniqueMessages.sort((a, b) => {
    let dateA = 0;
    let dateB = 0;
    
    // Try receivedtime (Unix timestamp in ms) - validate it's a valid number
    if (a.receivedtime && typeof a.receivedtime === 'number' && a.receivedtime > 0) {
      dateA = a.receivedtime;
    } else if (a.sentDateInGMT && typeof a.sentDateInGMT === 'number' && a.sentDateInGMT > 0) {
      dateA = a.sentDateInGMT;
    } else if (a.date) {
      try {
        const parsed = new Date(a.date);
        if (!isNaN(parsed.getTime())) {
          dateA = parsed.getTime();
        }
      } catch {
        // Invalid date, keep dateA as 0
      }
    }
    
    if (b.receivedtime && typeof b.receivedtime === 'number' && b.receivedtime > 0) {
      dateB = b.receivedtime;
    } else if (b.sentDateInGMT && typeof b.sentDateInGMT === 'number' && b.sentDateInGMT > 0) {
      dateB = b.sentDateInGMT;
    } else if (b.date) {
      try {
        const parsed = new Date(b.date);
        if (!isNaN(parsed.getTime())) {
          dateB = parsed.getTime();
        }
      } catch {
        // Invalid date, keep dateB as 0
      }
    }
    
    return dateB - dateA;
  });

  return uniqueMessages.slice(0, limit);
}

/**
 * Get full email content
 */
async function getEmailContent(
  folderId: string,
  messageId: string,
  accessToken: string,
  apiBaseUrl: string,
  accountId?: string,
): Promise<{ text: string; html: string }> {
  // Use correct endpoint format with account ID (or without if not available)
  const url = accountId
    ? `${apiBaseUrl}/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`
    : `${apiBaseUrl}/folders/${folderId}/messages/${messageId}/content`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get email content: ${errorText}`);
  }

  const data: ZohoEmailContentResponse = await response.json();
  return data.data.content;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    // Get authenticated user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return createErrorResponse(401, "Missing authorization header");
    }

    // Verify user session
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return createErrorResponse(401, "Invalid or expired token");
    }

    // Get sales user ID
    const { data: salesUser } = await supabaseAdmin
      .from("sales")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (!salesUser) {
      return createErrorResponse(403, "Sales user not found");
    }

    // Get user's Zoho OAuth tokens from database
    const { data: zohoToken, error: tokenError } = await supabaseAdmin
      .from("zoho_oauth_tokens")
      .select("*")
      .eq("sales_id", salesUser.id)
      .single();

    if (tokenError || !zohoToken) {
      return createErrorResponse(
        401,
        "Zoho Mail not connected. Please connect your Zoho Mail account first.",
      );
    }

    // Check if token is expired and refresh if needed
    const now = new Date();
    let expiresAt: Date;
    try {
      expiresAt = new Date(zohoToken.expires_at);
      if (isNaN(expiresAt.getTime())) {
        console.warn("Invalid expires_at date, treating as expired:", zohoToken.expires_at);
        expiresAt = new Date(0); // Set to epoch to force refresh
      }
    } catch (error) {
      console.warn("Error parsing expires_at, treating as expired:", error);
      expiresAt = new Date(0); // Set to epoch to force refresh
    }
    
    if (now >= expiresAt) {
      // Token expired, refresh it
      try {
        const refreshedToken = await refreshUserAccessToken(
          zohoToken.refresh_token,
          zohoToken.data_center || "eu",
        );
        
        // Update token in database
        const newExpiresAt = new Date();
        newExpiresAt.setSeconds(newExpiresAt.getSeconds() + (refreshedToken.expires_in || 3600));
        
        await supabaseAdmin
          .from("zoho_oauth_tokens")
          .update({
            access_token: refreshedToken.access_token,
            expires_at: newExpiresAt.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", zohoToken.id);
        
        // Update cached token
        zohoToken.access_token = refreshedToken.access_token;
        zohoToken.expires_at = newExpiresAt.toISOString();
      } catch (refreshError) {
        return createErrorResponse(
          401,
          "Failed to refresh Zoho Mail token. Please reconnect your account.",
        );
      }
    }

    // Use user's data center
    const userDataCenter = zohoToken.data_center || "eu";
    const userApiBaseUrl = ZOHO_API_BASE_URLS[userDataCenter] || ZOHO_API_BASE_URLS.us;

    if (req.method === "POST") {
      const { contactEmails, limit = 50, includeContent = false } = await req.json();

      if (!contactEmails || !Array.isArray(contactEmails) || contactEmails.length === 0) {
        return createErrorResponse(400, "contactEmails array is required");
      }

      try {
        // Get account ID (use stored or fetch from API)
        let accountId = await getAccountId(
          zohoToken.access_token,
          userApiBaseUrl,
          zohoToken.account_id,
        );
        
        // If we got an account ID but it's not stored, save it to the database
        if (accountId && !zohoToken.account_id) {
          console.log(`Saving account ID to database: ${accountId}`);
          await supabaseAdmin
            .from("zoho_oauth_tokens")
            .update({
              account_id: accountId,
              updated_at: new Date().toISOString(),
            })
            .eq("id", zohoToken.id);
        }
        
        if (!accountId) {
          return createErrorResponse(
            400,
            "Could not retrieve account ID from Zoho Mail. Please reconnect your Zoho Mail account.",
          );
        }
        
        // Search for emails using user's token, data center, and account ID
        const messages = await searchEmailsByContact(
          contactEmails,
          limit,
          zohoToken.access_token,
          userApiBaseUrl,
          accountId,
        );

        // Optionally fetch full content for each email
        // Normalize and format messages (handle different API response formats)
        const emailsWithContent = await Promise.all(
          messages.map(async (message: any) => {
            let content = { text: "", html: "" };
            if (includeContent) {
              const folderId = message.folderId || message.folder_id || message.folder?.id;
              const messageId = message.messageId || message.id || message.message_id;
              if (folderId && messageId) {
                try {
                  // Get account ID for content fetching
                  const accountId = await getAccountId(zohoToken.access_token, userApiBaseUrl) || zohoToken.account_email;
                  content = await getEmailContent(folderId, messageId, zohoToken.access_token, userApiBaseUrl, accountId);
                } catch (error) {
                  console.error(
                    `Error fetching content for message ${messageId}:`,
                    error,
                  );
                }
              }
            }

            // Normalize message structure according to Zoho Mail API response format
            // API returns: fromAddress, sender, subject, messageId, folderId, summary, receivedtime, etc.
            // We need to map these to our expected format
            const fromAddress = message.fromAddress || message.from?.email || message.from || "";
            const senderName = message.sender || message.from?.name || "";
            
            // Parse to addresses - API might return as string or array
            let toAddresses: Array<{ email: string; name: string }> = [];
            if (message.toAddress) {
              // If it's a string, convert to array
              if (typeof message.toAddress === 'string') {
                toAddresses = [{ email: message.toAddress, name: "" }];
              } else if (Array.isArray(message.toAddress)) {
                toAddresses = message.toAddress.map((addr: any) => 
                  typeof addr === 'string' ? { email: addr, name: "" } : { email: addr.email || addr, name: addr.name || "" }
                );
              }
            } else if (message.to) {
              toAddresses = Array.isArray(message.to) 
                ? message.to.map((addr: any) => typeof addr === 'string' ? { email: addr, name: "" } : addr)
                : [{ email: message.to, name: "" }];
            }
            
            // Parse date - API returns receivedtime as Unix timestamp in milliseconds
            // Handle invalid dates gracefully
            let emailDate = new Date().toISOString();
            try {
              if (message.receivedtime && typeof message.receivedtime === 'number' && message.receivedtime > 0) {
                emailDate = new Date(message.receivedtime).toISOString();
                // Validate the date is valid
                if (emailDate === 'Invalid Date') {
                  throw new Error('Invalid receivedtime');
                }
              } else if (message.sentDateInGMT && typeof message.sentDateInGMT === 'number' && message.sentDateInGMT > 0) {
                emailDate = new Date(message.sentDateInGMT).toISOString();
                if (emailDate === 'Invalid Date') {
                  throw new Error('Invalid sentDateInGMT');
                }
              } else if (message.date) {
                const parsedDate = new Date(message.date);
                if (!isNaN(parsedDate.getTime())) {
                  emailDate = parsedDate.toISOString();
                }
              }
            } catch (dateError) {
              console.warn(`Error parsing date for message ${message.messageId}:`, dateError);
              // Use current date as fallback
              emailDate = new Date().toISOString();
            }
            
            return {
              messageId: String(message.messageId || message.id || message.message_id || ""),
              folderId: String(message.folderId || message.folder_id || message.folder?.id || ""),
              subject: message.subject || message.Subject || "(No subject)",
              from: { 
                email: fromAddress, 
                name: senderName 
              },
              to: toAddresses,
              cc: Array.isArray(message.cc) 
                ? message.cc.map((addr: any) => typeof addr === 'string' ? { email: addr, name: "" } : addr)
                : (message.cc ? [{ email: message.cc, name: "" }] : []),
              date: emailDate,
              snippet: message.summary || message.snippet || message.Snippet || message.bodyPreview || message.body_preview || "",
              hasAttachments: message.hasAttachment === 1 || message.hasAttachment === true || message.hasAttachments === true || false,
              content: includeContent ? content : undefined,
            };
          }),
        );

        return new Response(
          JSON.stringify({
            success: true,
            emails: emailsWithContent,
            count: emailsWithContent.length,
          }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
            status: 200,
          },
        );
      } catch (error) {
        console.error("Zoho Mail API error:", error);
        return createErrorResponse(
          500,
          error instanceof Error ? error.message : "Failed to fetch emails from Zoho Mail",
        );
      }
    }

    return createErrorResponse(405, "Method not allowed");
  } catch (error) {
    console.error("Unexpected error:", error);
    return createErrorResponse(
      500,
      error instanceof Error ? error.message : "Internal server error",
    );
  }
});

