// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ImapClient } from "jsr:@workingdevshero/deno-imap";
import { simpleParser } from "npm:mailparser@3.7.1";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { getNoteContent } from "../postmark/getNoteContent.ts";
import { corsHeaders } from "../_shared/utils.ts";

// Decode MIME-encoded email subject
// Handles formats like: =?utf-8?B?...?= (Base64) and =?UTF-8?Q?...?= (Quoted-Printable)
function decodeMimeSubject(encoded: string): string {
  if (!encoded) return "";
  
  // Pattern to match MIME encoded words: =?charset?encoding?text?=
  const mimeWordPattern = /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g;
  
  return encoded.replace(mimeWordPattern, (match, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        // Base64 encoding
        const base64Text = text.replace(/\s/g, '');
        const binaryString = atob(base64Text);
        // For UTF-8, we can decode directly
        if (charset.toLowerCase().includes('utf-8') || charset.toLowerCase().includes('utf8')) {
          // Convert binary string to UTF-8
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          return new TextDecoder('utf-8').decode(bytes);
        } else {
          // For other charsets, return as-is (might need more handling)
          return binaryString;
        }
      } else if (encoding.toUpperCase() === 'Q') {
        // Quoted-Printable encoding
        let decoded = text
          .replace(/_/g, ' ') // Underscore represents space in QP
          .replace(/=([0-9A-F]{2})/gi, (_, hex) => {
            const charCode = parseInt(hex, 16);
            return String.fromCharCode(charCode);
          })
          .replace(/=\r?\n/g, ''); // Remove soft line breaks
        
        // Handle UTF-8 in QP encoding
        if (charset.toLowerCase().includes('utf-8') || charset.toLowerCase().includes('utf8')) {
          try {
            // QP might contain UTF-8 sequences, decode them
            return decodeURIComponent(decoded.replace(/=\?/g, '%'));
          } catch {
            return decoded;
          }
        }
        return decoded;
      }
    } catch (e) {
      console.error(`Error decoding MIME word: ${match}`, e);
      return match; // Return original if decoding fails
    }
    return match;
  });
}

// IMAP configuration from environment variables
const IMAP_HOST = Deno.env.get("IMAP_HOST");
const IMAP_PORT = parseInt(Deno.env.get("IMAP_PORT") || "993");
const IMAP_USER = Deno.env.get("IMAP_USER");
const IMAP_PASSWORD = Deno.env.get("IMAP_PASSWORD");
const IMAP_USE_TLS = Deno.env.get("IMAP_USE_TLS") !== "false";

if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) {
  throw new Error(
    "Missing IMAP configuration. Please set IMAP_HOST, IMAP_USER, and IMAP_PASSWORD environment variables.",
  );
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
    // Simple authentication - for personal use, we can make this optional
    const authHeader = req.headers.get("Authorization");
    const expectedAuth = Deno.env.get("IMAP_SYNC_AUTH_TOKEN");
    
    // Only check auth if a custom token is configured
    if (expectedAuth) {
      if (!authHeader || authHeader !== `Bearer ${expectedAuth}`) {
        return new Response(
          JSON.stringify({ error: "Unauthorized - Invalid token" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          },
        );
      }
    }

    // Parse query parameters
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "sync"; // "sync" or "process"
    const mode = url.searchParams.get("mode") || "incremental"; // "full" or "incremental"
    const offset = url.searchParams.get("offset"); // Sequence number to start from (for pagination)
    // Cap batch size at 20 to prevent timeouts on the Edge Function
    const batchSizeParam = parseInt(url.searchParams.get("batchSize") || "50");
    const batchSize = Math.min(batchSizeParam, 20);

    let result;
    if (action === "process") {
      // Process unprocessed emails (match to contacts and create notes)
      result = await processUnprocessedEmails(batchSize);
    } else {
      // Sync emails from IMAP
      result = await syncEmails(mode, offset ? parseInt(offset) : undefined, batchSize);
    }
    
    return new Response(
      JSON.stringify({
        success: true,
        processed: result.processed,
        errors: result.errors,
        totalFound: result.totalFound,
        nextOffset: result.nextOffset,
        hasMore: result.hasMore,
        stored: result.stored || 0,
        matched: result.matched || 0,
      }),
      {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  } catch (error) {
    console.error("IMAP sync error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }
});

async function syncEmails(
  mode: string = "incremental",
  offset?: number,
  batchSize: number = 50,
) {
  const processed: string[] = [];
  const errors: string[] = [];
  let totalFound = 0;
  let nextOffset: number | undefined = undefined;
  let hasMore = false;
  let stored = 0;
  let matched = 0;

  // Get first available sales user (for personal use)
  const { data: salesUsers } = await supabaseAdmin
    .from("sales")
    .select("*")
    .neq("disabled", true)
    .limit(1);
  
  if (!salesUsers || salesUsers.length === 0) {
    return {
      processed,
      errors: ["No active sales users found in database"],
      totalFound: 0,
      nextOffset: undefined,
      hasMore: false,
      stored: 0,
      matched: 0,
    };
  }
  
  const defaultSalesId = salesUsers[0].id;
  console.log(`Using sales user ID: ${defaultSalesId} (${salesUsers[0].email})`);

  // Create IMAP client
  const client = new ImapClient({
    host: IMAP_HOST!,
    port: IMAP_PORT,
    tls: IMAP_USE_TLS,
    username: IMAP_USER!,
    password: IMAP_PASSWORD!,
  });

  try {
    console.log(`Connecting to IMAP: ${IMAP_HOST}:${IMAP_PORT}`);
    await client.connect();
    console.log("Connected, authenticating...");
    await client.authenticate();
    console.log("Authenticated, selecting INBOX...");

    // Select INBOX
    const inbox = await client.selectMailbox("INBOX");
    console.log(`INBOX has ${inbox.exists} messages`);

    // Build search criteria based on mode
    let searchCriteria: any = {};
    
    if (mode === "full") {
      // Manual sync: get emails from last 12 months
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const dateStr = oneYearAgo.toISOString().split('T')[0];
      console.log(`Mode: FULL - Searching emails since ${dateStr} (last 12 months)...`);
      searchCriteria = { since: dateStr };
    } else {
      // Cron sync: only get today's emails
      const today = new Date();
      const dateStr = today.toISOString().split('T')[0];
      console.log(`Mode: INCREMENTAL - Searching for emails since ${dateStr}...`);
      searchCriteria = { since: dateStr };
    }

    // Search for messages
    console.log("Searching for messages...");
    const messageIds = await client.search(searchCriteria);
    console.log(`Found ${messageIds.length} messages`);
    totalFound = messageIds.length;
    
    if (messageIds.length === 0) {
      client.disconnect();
      return { 
        processed, 
        errors, 
        totalFound: 0,
        nextOffset: undefined,
        hasMore: false,
        stored: 0,
        matched: 0,
      };
    }

    // Filter by offset if provided (for pagination)
    let idsToProcess = messageIds;
    if (offset) {
      idsToProcess = messageIds.filter(id => id > offset);
      console.log(`Filtered to ${idsToProcess.length} messages after offset ${offset}`);
    }
    
    if (idsToProcess.length === 0) {
      client.disconnect();
      return { 
        processed, 
        errors, 
        totalFound,
        nextOffset: undefined,
        hasMore: false,
        stored: 0,
        matched: 0,
      };
    }

    // Process in batches
    const messagesToProcess = idsToProcess.slice(0, batchSize);
    hasMore = idsToProcess.length > batchSize;
    nextOffset = hasMore ? messagesToProcess[messagesToProcess.length - 1] : undefined;
    
    console.log(`Processing batch of ${messagesToProcess.length} messages (${hasMore ? 'more available' : 'last batch'})...`);

    // Fetch messages
    const fetchRange = messagesToProcess.length > 0 
      ? `${messagesToProcess[0]}:${messagesToProcess[messagesToProcess.length - 1]}`
      : `${messagesToProcess[0]}`;
    
    console.log(`Fetching messages for range: ${fetchRange}`);

    // Fetch messages using the configuration from the example
    // We ask for HEADER and TEXT parts specifically as they seem more reliable than 'raw' on some servers
    const messages = await client.fetch(fetchRange, {
      envelope: true,
      bodyStructure: true,
      bodyParts: ["HEADER", "TEXT"], 
      full: true,
    });

    console.log(`Fetched ${messages.length} messages`);

    // Store emails in database
    for (const message of messages) {
      try {
        const seq = message.seq || message.uid;
        console.log(`Processing message sequence: ${seq}`);
        
        if (!message.envelope) {
          console.log(`Skipping message ${seq}: no envelope`);
          continue;
        }

        // ... address extraction ...
        const fromAddress = message.envelope.from?.[0];
        const toAddresses = message.envelope.to || [];
        const ccAddresses = message.envelope.cc || [];
        const bccAddresses = message.envelope.bcc || [];
        
        if (!fromAddress || toAddresses.length === 0) {
          console.log(`Skipping message ${seq}: missing from or to addresses`);
          continue;
        }

        const fromEmail = `${fromAddress.mailbox}@${fromAddress.host}`;
        const fromName = fromAddress.name || "";

        // Decode MIME-encoded subject
        const rawSubject = message.envelope.subject || "";
        const decodedSubject = decodeMimeSubject(rawSubject);

        // Extract body using mailparser
        let bodyText = "";
        let bodyHtml = "";
        
        // Construct raw source from parts if available, otherwise try raw property
        let rawSource = "";
        
        if (message.parts && message.parts.HEADER && message.parts.TEXT) {
            // Reconstruct from HEADER and TEXT parts
            // Verify data types and decode if necessary
            const decoder = new TextDecoder();
            
            let headerStr = "";
            if (message.parts.HEADER.data instanceof Uint8Array) {
                headerStr = decoder.decode(message.parts.HEADER.data);
            } else if (typeof message.parts.HEADER === 'string') {
                headerStr = message.parts.HEADER;
            }
            
            let textStr = "";
            if (message.parts.TEXT.data instanceof Uint8Array) {
                textStr = decoder.decode(message.parts.TEXT.data);
            } else if (typeof message.parts.TEXT === 'string') {
                textStr = message.parts.TEXT;
            }
            
            if (headerStr && textStr) {
                rawSource = headerStr + textStr;
                console.log(`Message ${seq}: Reconstructed raw source from HEADER and TEXT parts (len: ${rawSource.length})`);
            }
        } 
        
        if (!rawSource && message.raw) {
             if (typeof message.raw === 'string') {
                rawSource = message.raw;
             } else if (message.raw instanceof Uint8Array) {
                rawSource = new TextDecoder().decode(message.raw);
             }
             console.log(`Message ${seq}: Used message.raw (len: ${rawSource.length})`);
        }

        if (rawSource) {
          try {
             const parsed = await simpleParser(rawSource);
             if (parsed.text) bodyText = parsed.text;
             if (parsed.html) bodyHtml = parsed.html as string;
             console.log(`Message ${seq}: mailparser success. Text len: ${bodyText ? bodyText.length : 0}, HTML len: ${bodyHtml ? bodyHtml.length : 0}`);
          } catch (e) {
             console.error(`Message ${seq}: mailparser failed:`, e);
          }
        } else {
           console.log(`Message ${seq}: No raw source available (neither parts nor raw property working)`);
           console.log(`DEBUG: Message ${seq} parts keys:`, message.parts ? Object.keys(message.parts) : 'None');
        }
        
        // Also check parts array if raw didn't work
        if ((!bodyText && !bodyHtml) && message.parts && Array.isArray(message.parts)) {
          console.log(`Message ${seq}: Trying parts array, found ${message.parts.length} parts`);
          for (const part of message.parts) {
            if (typeof part === 'string') {
              bodyText += part;
            } else if (part && typeof part === 'object') {
              const partBody = part.body || part.content || part.data || part.text;
              if (partBody && typeof partBody === 'string') {
                const partType = ((part.type || '') + '/' + (part.subtype || '')).toLowerCase();
                if (partType.includes('html')) {
                  bodyHtml += partBody;
                } else {
                  bodyText += partBody;
                }
              }
            }
          }
        }
        
        console.log(`Message ${seq}: Final extraction - bodyText length: ${bodyText.length}, bodyHtml length: ${bodyHtml.length}`);

        // Check if email already exists (by message ID or UID)
        const messageId = message.envelope.messageId || `imap-${seq}`;
        const imapUid = message.uid || seq;

        const { data: existingEmail } = await supabaseAdmin
          .from("emails")
          .select("id, processed")
          .or(`message_id.eq.${messageId},imap_uid.eq.${imapUid}`)
          .maybeSingle();

        if (existingEmail) {
          console.log(`Email ${seq} already exists in database, skipping`);
          processed.push(String(seq));
          continue;
        }

        // Store email in database
        const toEmailsJson = toAddresses.map((addr: any) => ({
          email: `${addr.mailbox}@${addr.host}`,
          name: addr.name || "",
        }));

        const ccEmailsJson = ccAddresses?.map((addr: any) => ({
          email: `${addr.mailbox}@${addr.host}`,
          name: addr.name || "",
        })) || null;

        const bccEmailsJson = bccAddresses?.map((addr: any) => ({
          email: `${addr.mailbox}@${addr.host}`,
          name: addr.name || "",
        })) || null;

        const { data: storedEmail, error: storeError } = await supabaseAdmin
          .from("emails")
          .insert({
            message_id: messageId,
            imap_uid: imapUid,
            from_email: fromEmail,
            from_name: fromName,
            to_emails: toEmailsJson,
            cc_emails: ccEmailsJson,
            bcc_emails: bccEmailsJson,
            subject: decodedSubject,
            body_text: bodyText,
            body_html: bodyHtml,
            date: message.envelope.date ? new Date(message.envelope.date) : new Date(),
            processed: false,
            sales_id: defaultSalesId,
          })
          .select()
          .single();

        if (storeError || !storedEmail) {
          const errorMsg = `Failed to store email ${seq}: ${storeError?.message || 'Unknown error'}`;
          errors.push(errorMsg);
          console.error(errorMsg);
          continue;
        }

        console.log(`Stored email ${seq} in database (ID: ${storedEmail.id})`);
        stored++;
        
        // Try to match email to existing contacts and create notes
        await matchEmailToContacts(storedEmail.id, fromEmail, toEmailsJson, decodedSubject, bodyText, defaultSalesId);
        matched++;
        
        processed.push(String(seq));
      } catch (error) {
        const errorMsg = `Error processing message ${message.seq || message.uid}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(errorMsg);
        console.error(errorMsg);
      }
    }

    console.log("Disconnecting...");
    client.disconnect();
    
    return { 
      processed, 
      errors,
      totalFound,
      nextOffset,
      hasMore,
      stored,
      matched,
    };
  } catch (error) {
    const errorMsg = `IMAP error: ${error instanceof Error ? error.message : String(error)}`;
    errors.push(errorMsg);
    console.error(errorMsg);
    
    try {
      client.disconnect();
    } catch (e) {
      // Ignore disconnect errors
      console.error("Error disconnecting:", e);
    }
    
    return { 
      processed, 
      errors,
      totalFound,
      nextOffset: undefined,
      hasMore: false,
      stored: 0,
      matched: 0,
    };
  }
}


// Check if any participant (From/To/CC) matches a contact
async function findContactForEmail(
  participants: string[]
): Promise<{ id: number } | null> {
  // Normalize emails
  const emails = participants.map(e => e.toLowerCase().trim());
  
  if (emails.length === 0) return null;

  // Search for any contact that has one of these emails in their email_jsonb
  // We can't do a simple "contains" for multiple emails efficiently in one query without complex logic
  // So we'll loop for now, or we could use a more complex RPC if performance becomes an issue
  
  for (const email of emails) {
      const { data: contact, error } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .contains("email_jsonb", JSON.stringify([{ email: email }]))
        .maybeSingle();
        
      if (contact && !error) {
          return contact;
      }
  }
  
  return null;
}

// Match email to contacts and create notes
async function matchEmailToContacts(
  emailId: number,
  fromEmail: string,
  toEmails: Array<{ email: string; name: string }>,
  subject: string,
  bodyText: string,
  salesId: number,
) {
  const noteContent = getNoteContent(subject, bodyText);
  
  // Collect all unique email addresses involved in this conversation
  const allParticipants = new Set<string>();
  allParticipants.add(fromEmail);
  toEmails.forEach(t => allParticipants.add(t.email));
  
  try {
      const contact = await findContactForEmail(Array.from(allParticipants));

      if (contact) {
        // Contact exists - create note and link email
        const { error: noteError } = await supabaseAdmin
          .from("contactNotes")
          .insert({
            contact_id: contact.id,
            text: noteContent,
            sales_id: salesId,
          });

        if (noteError) {
          console.error(`Error creating note for contact ${contact.id}:`, noteError);
        } else {
          console.log(`Created note for existing contact ID: ${contact.id}`);
          
          // Update contact's last_seen
          await supabaseAdmin
            .from("contacts")
            .update({ last_seen: new Date() })
            .eq("id", contact.id);
        }

        // Link email to contact
        await supabaseAdmin
          .from("emails")
          .update({ 
            contact_id: contact.id,
            processed: true,
          })
          .eq("id", emailId);
      } else {
        console.log(`No contact found for participants: ${Array.from(allParticipants).join(', ')}`);
      }
  } catch (error) {
      console.error(`Error matching email ${emailId} to contacts:`, error);
  }
}

// Process unprocessed emails (match to contacts and create notes)
// Useful when new contacts are added and we want to link existing emails
async function processUnprocessedEmails(batchSize: number = 50) {
  const processed: number[] = [];
  const errors: string[] = [];
  let matched = 0;

  // Get first available sales user
  const { data: salesUsers } = await supabaseAdmin
    .from("sales")
    .select("*")
    .neq("disabled", true)
    .limit(1);
  
  if (!salesUsers || salesUsers.length === 0) {
    return {
      processed,
      errors: ["No active sales users found in database"],
      stored: 0,
      matched: 0,
    };
  }
  
  const defaultSalesId = salesUsers[0].id;

  // Get unprocessed emails
  const { data: emails, error: fetchError } = await supabaseAdmin
    .from("emails")
    .select("*")
    .eq("processed", false)
    .limit(batchSize);

  if (fetchError) {
    return {
      processed,
      errors: [`Error fetching unprocessed emails: ${fetchError.message}`],
      stored: 0,
      matched: 0,
    };
  }

  if (!emails || emails.length === 0) {
    return {
      processed,
      errors: [],
      stored: 0,
      matched: 0,
    };
  }

  console.log(`Processing ${emails.length} unprocessed emails...`);

  for (const email of emails) {
    try {
      await matchEmailToContacts(
        email.id,
        email.from_email,
        email.to_emails as Array<{ email: string; name: string }>,
        email.subject || "",
        email.body_text || "",
        email.sales_id || defaultSalesId,
      );
      processed.push(email.id);
      matched++;
    } catch (error) {
      const errorMsg = `Error processing email ${email.id}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(errorMsg);
      console.error(errorMsg);
    }
  }

  return {
    processed,
    errors,
    stored: 0,
    matched,
  };
}
