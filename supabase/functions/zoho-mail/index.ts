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
  data?: {
    content?: {
      text?: string;
      html?: string;
    };
  };
  content?: {
    text?: string;
    html?: string;
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
 * Extract email address from string that might contain name (e.g., "Name <email@example.com>" or just "email@example.com")
 */
function extractEmailAddress(emailString: string): string {
  if (!emailString) return "";
  
  // If it's already just an email, return it
  if (/^[^\s<]+@[^\s>]+$/.test(emailString.trim())) {
    return emailString.trim().toLowerCase();
  }
  
  // Try to extract email from "Name <email@example.com>" format
  const emailMatch = emailString.match(/<([^>]+)>/);
  if (emailMatch && emailMatch[1]) {
    return emailMatch[1].trim().toLowerCase();
  }
  
  // Try to extract email from string (look for @ symbol)
  const atIndex = emailString.indexOf('@');
  if (atIndex > 0) {
    // Find the start of the email (look backwards for space or <)
    let start = atIndex;
    while (start > 0 && emailString[start - 1] !== ' ' && emailString[start - 1] !== '<') {
      start--;
    }
    // Find the end of the email (look forwards for space or >)
    let end = atIndex;
    while (end < emailString.length && emailString[end] !== ' ' && emailString[end] !== '>') {
      end++;
    }
    const extracted = emailString.substring(start, end).replace(/[<>]/g, '').trim();
    if (extracted.includes('@')) {
      return extracted.toLowerCase();
    }
  }
  
  // Fallback: return trimmed lowercase version
  return emailString.trim().toLowerCase();
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
 * Helper function to fetch all pages of search results with pagination
 */
async function fetchAllSearchResults(
  searchUrl: string,
  accessToken: string,
  maxResults: number = 10000, // Very high limit to get all emails
): Promise<any[]> {
  const allMessages: any[] = [];
  let start = 0;
  const pageSize = 200; // Fetch 200 at a time (Zoho API max is typically 200)
  let hasMore = true;

  while (hasMore && allMessages.length < maxResults) {
    const urlWithPagination = `${searchUrl}${searchUrl.includes('?') ? '&' : '?'}start=${start}&limit=${pageSize}`;
    
    try {
      const response = await fetch(urlWithPagination, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`Search pagination failed: ${response.status} - ${errorText.substring(0, 200)}`);
        break;
      }

      const data: any = await response.json();
      let messages: any[] = [];
      
      if (data?.data && Array.isArray(data.data)) {
        messages = data.data;
      } else if (data?.messages && Array.isArray(data.messages)) {
        messages = data.messages;
      }

      if (messages.length === 0) {
        hasMore = false;
        break;
      }

      allMessages.push(...messages);
      console.log(`Fetched page: ${allMessages.length} total messages so far`);

      // Check if there are more results
      // Zoho API typically indicates more results if we got a full page
      if (messages.length < pageSize) {
        hasMore = false;
      } else {
        start += pageSize;
        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`Error fetching search results page:`, error);
      break;
    }
  }

  return allMessages;
}

/**
 * Search emails by contact email addresses across all accounts
 * Now fetches ALL emails with pagination support
 */
async function searchEmailsByContact(
  contactEmails: string[],
  limit: number = 10000, // Very high default limit to get all emails
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

  // Get folder IDs for Inbox and Sent - always fetch Sent folder to ensure we get sent emails
  let inboxFolderId: string | null = null;
  let sentFolderId: string | null = null;
  
  // Always fetch Sent folder ID to search for emails the user sent to contacts
  // Try multiple possible names for Sent folder
  try {
    sentFolderId = await getFolderId("Sent", accessToken, apiBaseUrl, accountId);
    if (!sentFolderId) {
      // Try alternative names
      sentFolderId = await getFolderId("Sent Items", accessToken, apiBaseUrl, accountId);
    }
    if (!sentFolderId) {
      sentFolderId = await getFolderId("Sent Mail", accessToken, apiBaseUrl, accountId);
    }
    console.log(`Sent folder ID: ${sentFolderId || "not found"}`);
    
    if (!sentFolderId) {
      // List all folders to see what's available
      try {
        const foldersUrl = `${apiBaseUrl}/accounts/${accountId}/folders`;
        const foldersResponse = await fetch(foldersUrl, {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            "Content-Type": "application/json",
          },
        });
        if (foldersResponse.ok) {
          const foldersData: any = await foldersResponse.json();
          const folders = foldersData?.data?.folders || foldersData?.folders || foldersData?.data || [];
          console.log(`Available folders:`, folders.map((f: any) => f.name || f.folderName).join(", "));
        }
      } catch (error) {
        console.warn("Error listing folders:", error);
      }
    }
  } catch (error) {
    console.warn("Error fetching Sent folder ID:", error);
  }

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
      
      // Approach 1: Search for emails FROM this contact (with pagination)
      const fromSearchKey = `from:${email}`;
      const fromSearchUrl = `${apiBaseUrl}/accounts/${accountId}/messages/search?searchKey=${encodeURIComponent(fromSearchKey)}&includeto=true`;

      console.log(`Searching emails FROM: ${email} (with pagination)`);
      const fromMessages = await fetchAllSearchResults(fromSearchUrl, accessToken, limit);
      
      if (fromMessages.length > 0) {
        // Filter to ensure emails actually match the contact email
        const filteredMessages = fromMessages.filter((msg: any) => {
          const fromAddr = extractEmailAddress(String(msg.fromAddress || msg.from?.email || msg.from || ""));
          return fromAddr === email.toLowerCase();
        });
        console.log(`Found ${fromMessages.length} messages FROM ${email}, filtered to ${filteredMessages.length} matching messages`);
        allMessages.push(...filteredMessages);
      }
      
      // Approach 2: Search for emails TO this contact (with pagination)
      const toSearchKey = `to:${email}`;
      const toSearchUrl = `${apiBaseUrl}/accounts/${accountId}/messages/search?searchKey=${encodeURIComponent(toSearchKey)}&includeto=true`;

      console.log(`Searching emails TO: ${email} (with pagination)`);
      const toMessages = await fetchAllSearchResults(toSearchUrl, accessToken, limit);
      
      if (toMessages.length > 0) {
        // Filter to ensure emails actually match the contact email in TO field
        const filteredMessages = toMessages.filter((msg: any) => {
          const toAddresses = msg.toAddress || msg.to || [];
          const toArray = Array.isArray(toAddresses) ? toAddresses : [toAddresses];
          return toArray.some((addr: any) => {
            const addrRaw = typeof addr === 'string' ? addr : (addr.email || addr.address || "");
            const addrEmail = extractEmailAddress(String(addrRaw));
            return addrEmail === email.toLowerCase();
          });
        });
        console.log(`Found ${toMessages.length} messages TO ${email}, filtered to ${filteredMessages.length} matching messages`);
        allMessages.push(...filteredMessages);
      }
      
      // Approach 3: Try searching for emails where contact is in CC (with pagination)
      const ccSearchKey = `cc:${email}`;
      const ccSearchUrl = `${apiBaseUrl}/accounts/${accountId}/messages/search?searchKey=${encodeURIComponent(ccSearchKey)}&includeto=true`;

      console.log(`Searching emails CC: ${email} (with pagination)`);
      const ccMessages = await fetchAllSearchResults(ccSearchUrl, accessToken, limit);
      
      if (ccMessages.length > 0) {
        // Filter to ensure emails actually match the contact email in CC field
        const filteredMessages = ccMessages.filter((msg: any) => {
          const ccAddresses = msg.ccAddress || msg.cc || [];
          const ccArray = Array.isArray(ccAddresses) ? ccAddresses : [ccAddresses];
          return ccArray.some((addr: any) => {
            const addrEmail = extractEmailAddress(String(typeof addr === 'string' ? addr : (addr.email || "")));
            return addrEmail === email.toLowerCase();
          });
        });
        console.log(`Found ${ccMessages.length} messages CC ${email}, filtered to ${filteredMessages.length} matching messages`);
        allMessages.push(...filteredMessages);
      }

      // Approach 4: Always search in Sent folder for emails the user sent TO the contact (with pagination)
      // This ensures we capture all emails the user sent to the contact
      if (sentFolderId) {
        // Try multiple search approaches for Sent folder
        // Method 1: Search with to: prefix
        const sentToSearch = `to:${email}`;
        const sentToUrl = `${apiBaseUrl}/accounts/${accountId}/folders/${sentFolderId}/messages/search?searchKey=${encodeURIComponent(sentToSearch)}&includeto=true`;
        console.log(`[SENT FOLDER] Searching for emails TO: ${email} in folder ${sentFolderId} (with pagination)`);
        
        const sentMessages = await fetchAllSearchResults(sentToUrl, accessToken, limit);
        console.log(`[SENT FOLDER] Found ${sentMessages.length} messages from search`);
        
        if (sentMessages.length > 0) {
          // Log sample message structure for debugging
          console.log(`[SENT FOLDER] Sample message structure:`, JSON.stringify(sentMessages[0], null, 2));
          
          // Filter to ensure emails actually match the contact email in TO field
          const filteredMessages = sentMessages.filter((msg: any) => {
            const toAddresses = msg.toAddress || msg.to || [];
            const toArray = Array.isArray(toAddresses) ? toAddresses : [toAddresses];
            const matches = toArray.some((addr: any) => {
              const addrRaw = typeof addr === 'string' ? addr : (addr.email || addr.address || "");
              const addrEmail = extractEmailAddress(String(addrRaw));
              const match = addrEmail === email.toLowerCase();
              if (!match && sentMessages.length <= 5) {
                console.log(`[SENT FOLDER] Email mismatch: extracted "${addrEmail}" vs contact "${email.toLowerCase()}" from raw: "${addrRaw}"`);
              }
              return match;
            });
            return matches;
          });
          console.log(`[SENT FOLDER] Found ${sentMessages.length} sent messages TO ${email}, filtered to ${filteredMessages.length} matching messages`);
          
          if (filteredMessages.length > 0) {
            allMessages.push(...filteredMessages);
          } else if (sentMessages.length > 0) {
            // If filtering removed all messages, log why
            console.warn(`[SENT FOLDER] All ${sentMessages.length} messages were filtered out. Sample TO addresses:`, 
              sentMessages.slice(0, 3).map((m: any) => ({
                toAddress: m.toAddress,
                to: m.to,
                messageId: m.messageId
              }))
            );
          }
        } else {
          // Method 2: Try searching without searchKey, just get all messages from Sent folder and filter
          console.log(`[SENT FOLDER] No results from search, trying to fetch all messages from Sent folder`);
          try {
            const sentAllUrl = `${apiBaseUrl}/accounts/${accountId}/folders/${sentFolderId}/messages?includeto=true&limit=200`;
            const sentAllResponse = await fetch(sentAllUrl, {
              headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
                "Content-Type": "application/json",
              },
            });
            
            if (sentAllResponse.ok) {
              const sentAllData: any = await sentAllResponse.json();
              const allSentMessages = sentAllData?.data || sentAllData?.messages || [];
              console.log(`[SENT FOLDER] Fetched ${allSentMessages.length} total messages from Sent folder`);
              
              // Filter to find emails sent TO the contact
              const filteredSentMessages = allSentMessages.filter((msg: any) => {
                const toAddresses = msg.toAddress || msg.to || [];
                const toArray = Array.isArray(toAddresses) ? toAddresses : [toAddresses];
                return toArray.some((addr: any) => {
                  const addrRaw = typeof addr === 'string' ? addr : (addr.email || addr.address || "");
                  const addrEmail = extractEmailAddress(String(addrRaw));
                  return addrEmail === email.toLowerCase();
                });
              });
              
              if (filteredSentMessages.length > 0) {
                console.log(`[SENT FOLDER] Found ${filteredSentMessages.length} messages sent TO ${email} from all Sent messages`);
                allMessages.push(...filteredSentMessages);
              }
            }
          } catch (error) {
            console.error(`[SENT FOLDER] Error fetching all messages from Sent folder:`, error);
          }
        }
      } else {
        console.warn(`[SENT FOLDER] Sent folder ID not found, cannot search sent emails for ${email}`);
      }

      // Approach 5: Search in Inbox folder as well (with pagination)
      if (!inboxFolderId) {
        inboxFolderId = await getFolderId("Inbox", accessToken, apiBaseUrl, accountId);
      }
      
      if (inboxFolderId) {
        // Search for emails FROM this contact in Inbox
        const inboxFromSearch = `from:${email}`;
        const inboxFromUrl = `${apiBaseUrl}/accounts/${accountId}/folders/${inboxFolderId}/messages/search?searchKey=${encodeURIComponent(inboxFromSearch)}&includeto=true`;
        console.log(`Searching in Inbox folder FROM: ${email} (with pagination)`);
        
        const inboxMessages = await fetchAllSearchResults(inboxFromUrl, accessToken, limit);
        
        if (inboxMessages.length > 0) {
          console.log(`Found ${inboxMessages.length} messages in Inbox FROM ${email}`);
          allMessages.push(...inboxMessages);
        }
      }
    } catch (error) {
      console.error(`Error searching emails for ${email}:`, error);
    }
  }
  
  console.log(`Total messages found before filtering: ${allMessages.length}`);
  if (allMessages.length > 0) {
    console.log(`Sample message structure:`, JSON.stringify(allMessages[0], null, 2));
  }

  // Final filter: Ensure all messages actually match one of the contact emails
  // This is important because the searchKey might not be filtering correctly
  // For sent emails: FROM will be user's email, TO will be contact's email
  // For received emails: FROM will be contact's email, TO will be user's email
  const contactEmailSet = new Set(normalizedEmails);
  console.log(`Filtering messages against contact emails: ${Array.from(contactEmailSet).join(", ")}`);
  console.log(`Total messages before final filter: ${allMessages.length}`);
  
  const filteredMessages = allMessages.filter((msg: any) => {
    // Check FROM field (for emails FROM contact)
    const fromRaw = msg.fromAddress || msg.from?.email || msg.from || "";
    const fromAddr = extractEmailAddress(String(fromRaw));
    if (fromAddr && contactEmailSet.has(fromAddr)) {
      console.log(`Message ${msg.messageId || msg.id} matched via FROM: ${fromAddr}`);
      return true;
    }
    
    // Check TO field (for emails TO contact - this includes sent emails)
    const toAddresses = msg.toAddress || msg.to || [];
    const toArray = Array.isArray(toAddresses) ? toAddresses : [toAddresses];
    for (const addr of toArray) {
      const addrRaw = typeof addr === 'string' ? addr : (addr.email || addr.address || "");
      const addrEmail = extractEmailAddress(String(addrRaw));
      if (addrEmail && contactEmailSet.has(addrEmail)) {
        console.log(`Message ${msg.messageId || msg.id} matched via TO: ${addrEmail}`);
        return true;
      }
    }
    
    // Check CC field
    const ccAddresses = msg.ccAddress || msg.cc || [];
    const ccArray = Array.isArray(ccAddresses) ? ccAddresses : [ccAddresses];
    for (const addr of ccArray) {
      const addrRaw = typeof addr === 'string' ? addr : (addr.email || addr.address || "");
      const addrEmail = extractEmailAddress(String(addrRaw));
      if (addrEmail && contactEmailSet.has(addrEmail)) {
        console.log(`Message ${msg.messageId || msg.id} matched via CC: ${addrEmail}`);
        return true;
      }
    }
    
    // Log why message was filtered out (only for first few to avoid spam)
    if (allMessages.length <= 20) {
      console.log(`Message ${msg.messageId || msg.id} filtered out. FROM: ${fromAddr}, TO: ${JSON.stringify(toArray.map(a => {
        const aRaw = typeof a === 'string' ? a : (a.email || a.address || "");
        return extractEmailAddress(String(aRaw));
      }))}, Contact emails: ${Array.from(contactEmailSet).join(", ")}`);
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

  // Return ALL unique messages (no limit slicing)
  return uniqueMessages;
}

/**
 * Get full email content
 * This fetches the complete email body (text and HTML) from Zoho Mail API
 */
async function getEmailContent(
  folderId: string,
  messageId: string,
  accessToken: string,
  apiBaseUrl: string,
  accountId?: string,
): Promise<{ text: string; html: string }> {
  // Use correct endpoint format with account ID (required for Zoho Mail API)
  if (!accountId) {
    throw new Error("Account ID is required to fetch email content");
  }
  
  const url = `${apiBaseUrl}/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Failed to get email content for message ${messageId} in folder ${folderId}: ${response.status} - ${errorText}`);
    throw new Error(`Failed to get email content (${response.status}): ${errorText.substring(0, 200)}`);
  }

  const data: ZohoEmailContentResponse = await response.json();
  
  // Handle different response structures
  if (data?.data?.content) {
    return {
      text: data.data.content.text || "",
      html: data.data.content.html || "",
    };
  } else if (data?.content) {
    return {
      text: data.content.text || "",
      html: data.content.html || "",
    };
  } else {
    console.warn(`Unexpected response structure for email content:`, JSON.stringify(data, null, 2));
    return { text: "", html: "" };
  }
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
      const { contactEmails, limit = 10000, includeContent = false } = await req.json();

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

        // Always fetch full content for each email (includeContent should be true)
        console.log(`Fetching emails with includeContent=${includeContent}, total messages: ${messages.length}`);
        
        // Normalize and format messages (handle different API response formats)
        const emailsWithContent = await Promise.all(
          messages.map(async (message: any) => {
            let content = { text: "", html: "" };
            const folderId = message.folderId || message.folder_id || message.folder?.id;
            const messageId = message.messageId || message.id || message.message_id;
            
            // Always try to fetch content if we have the required IDs
            if (folderId && messageId) {
              try {
                // Use the accountId we already have (don't fetch it again)
                content = await getEmailContent(folderId, messageId, zohoToken.access_token, userApiBaseUrl, accountId);
                const hasContent = !!(content.text || content.html);
                console.log(`Fetched content for message ${messageId}: hasText=${!!content.text}, hasHtml=${!!content.html}, length=${content.text?.length || 0}/${content.html?.length || 0}`);
                
                if (!hasContent) {
                  console.warn(`Content fetched but empty for message ${messageId} in folder ${folderId}`);
                }
              } catch (error) {
                console.error(
                  `Error fetching content for message ${messageId} in folder ${folderId}:`,
                  error instanceof Error ? error.message : String(error),
                );
                // Continue without content - we'll still return the email with snippet
                // This ensures we don't lose emails if content fetching fails
              }
            } else {
              console.warn(`Missing folderId or messageId for message:`, { 
                folderId, 
                messageId, 
                hasFolderId: !!folderId,
                hasMessageId: !!messageId,
                messageKeys: Object.keys(message)
              });
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
            
            // Always include content if we have it (even if empty strings)
            // The frontend will check if content.text or content.html exist
            const hasContent = !!(content.text || content.html);
            
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
              // Always include content object if we attempted to fetch it (even if empty)
              // Frontend will check if content.text or content.html have actual values
              content: hasContent ? content : (includeContent ? { text: "", html: "" } : undefined),
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

