// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ImapClient } from "jsr:@workingdevshero/deno-imap";
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
    const batchSize = parseInt(url.searchParams.get("batchSize") || "50"); // Emails per batch

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
    
    // Fetch messages with envelope, bodyStructure, and raw message
    // We'll parse the body from the raw message
    const messages = await client.fetch(fetchRange, {
      envelope: true,
      bodyStructure: true,
      raw: true, // Fetch raw message to parse body
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

        // Extract body text and HTML
        let bodyText = "";
        let bodyHtml = "";
        
        // Try to parse from raw message first (most reliable)
        let rawMessage = "";
        if (message.raw) {
          if (typeof message.raw === 'string') {
            rawMessage = message.raw;
          } else if (message.raw instanceof Uint8Array) {
            rawMessage = new TextDecoder().decode(message.raw);
          } else {
            console.log(`Message ${seq}: raw property exists but unknown type: ${typeof message.raw}`);
          }
        }

        if (rawMessage) {
          console.log(`Message ${seq}: parsing raw message, length: ${rawMessage.length}`);
          
          // Split headers and body - try more robust splitting
          const splitMatch = rawMessage.match(/\r?\n\r?\n/);
          if (splitMatch && splitMatch.index) {
            const headers = rawMessage.substring(0, splitMatch.index);
            const rawBody = rawMessage.substring(splitMatch.index + splitMatch[0].length);
            
            console.log(`Message ${seq}: Split successful. Header len: ${headers.length}, Body len: ${rawBody.length}`);

            // Parse Content-Type from headers
            const contentTypeHeader = headers.match(/^Content-Type:\s*([^\r\n]+)/im);
            const contentType = contentTypeHeader ? contentTypeHeader[1] : 'text/plain';
            console.log(`Message ${seq}: Content-Type: ${contentType}`);
            
            if (contentType.toLowerCase().includes('multipart')) {
              // Parse multipart message
              const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
              if (boundaryMatch) {
                const boundary = boundaryMatch[1];
                console.log(`Message ${seq}: Boundary found: ${boundary}`);
                
                // Split by boundary
                const parts = rawBody.split(`--${boundary}`);
                
                for (const part of parts) {
                  if (!part.trim() || part.trim() === '--') continue;
                  
                  const partSplitMatch = part.match(/\r?\n\r?\n/);
                  if (partSplitMatch && partSplitMatch.index) {
                    const partHeaders = part.substring(0, partSplitMatch.index);
                    const partContent = part.substring(partSplitMatch.index + partSplitMatch[0].length);
                    
                    const partContentTypeHeader = partHeaders.match(/^Content-Type:\s*([^\r\n]+)/im);
                    const partContentType = partContentTypeHeader ? partContentTypeHeader[1].toLowerCase() : 'text/plain';
                    
                    const partEncodingHeader = partHeaders.match(/^Content-Transfer-Encoding:\s*([^\r\n]+)/im);
                    const partEncoding = partEncodingHeader ? partEncodingHeader[1].toLowerCase() : '';
                    
                    console.log(`Message ${seq}: Part Content-Type: ${partContentType}, Encoding: ${partEncoding}`);
                    
                    let decodedPart = partContent.trim();
                    try {
                      if (partEncoding === 'base64') {
                        decodedPart = atob(decodedPart.replace(/\s/g, ''));
                        // Decode UTF-8 if needed
                        const bytes = new Uint8Array([...decodedPart].map(c => c.charCodeAt(0)));
                        decodedPart = new TextDecoder().decode(bytes);
                      } else if (partEncoding === 'quoted-printable') {
                        decodedPart = decodedPart
                          .replace(/=\r?\n/g, '')
                          .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
                      }
                    } catch (e) {
                      console.error(`Message ${seq}: Error decoding part:`, e);
                    }

                    if (partContentType.includes('text/html')) {
                      bodyHtml += decodedPart;
                    } else if (partContentType.includes('text/plain')) {
                      bodyText += decodedPart;
                    }
                  }
                }
              }
            } else {
              // Single part message
              const encodingHeader = headers.match(/^Content-Transfer-Encoding:\s*([^\r\n]+)/im);
              const encoding = encodingHeader ? encodingHeader[1].toLowerCase() : '';
              
              let decodedBody = rawBody.trim();
              try {
                if (encoding === 'base64') {
                  decodedBody = atob(decodedBody.replace(/\s/g, ''));
                  const bytes = new Uint8Array([...decodedBody].map(c => c.charCodeAt(0)));
                  decodedBody = new TextDecoder().decode(bytes);
                } else if (encoding === 'quoted-printable') {
                   decodedBody = decodedBody
                     .replace(/=\r?\n/g, '')
                     .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
                }
              } catch (e) {
                console.error(`Message ${seq}: Error decoding body:`, e);
              }

              if (contentType.toLowerCase().includes('text/html')) {
                bodyHtml = decodedBody;
              } else {
                bodyText = decodedBody;
              }
            }
          }
        } else {
           console.log(`Message ${seq}: No raw string available (message.raw is ${typeof message.raw})`);
           // Attempt to fetch specific body parts as fallback
           if (message.parts && Array.isArray(message.parts) && message.parts.length > 0) {
             console.log(`Message ${seq}: Fallback - trying to fetch body parts individually`);
             try {
               // Try fetching part 1
               const part1Messages = await client.fetch(`${seq}`, { body: '1' });
               if (part1Messages && part1Messages.length > 0 && part1Messages[0].body) {
                 const p1 = part1Messages[0].body;
                 const content = typeof p1 === 'string' ? p1 : (p1.text || p1.content || '');
                 if (content) {
                    bodyText += content;
                    console.log(`Message ${seq}: Fetched part 1, len: ${content.length}`);
                 }
               }
               
                // Try fetching part 2 (often HTML in multipart/alternative)
               const part2Messages = await client.fetch(`${seq}`, { body: '2' });
               if (part2Messages && part2Messages.length > 0 && part2Messages[0].body) {
                 const p2 = part2Messages[0].body;
                 const content = typeof p2 === 'string' ? p2 : (p2.text || p2.content || '');
                 if (content) {
                    bodyHtml += content;
                    console.log(`Message ${seq}: Fetched part 2, len: ${content.length}`);
                 }
               }
             } catch (e) {
               console.error(`Message ${seq}: Error fetching individual parts:`, e);
             }
           }
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
  
  for (const toEmail of toEmails) {
    try {
      // Try to find existing contact by email
      // email_jsonb is an array like: [{"email": "test@example.com", "type": "Other"}]
      // Use the same pattern as addNoteToContact
      const { data: contact, error: contactError } = await supabaseAdmin
        .from("contacts")
        .select("*")
        .contains("email_jsonb", JSON.stringify([{ email: toEmail.email }]))
        .maybeSingle();

      if (contactError) {
        console.error(`Error finding contact for ${toEmail.email}:`, contactError);
        continue;
      }

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
          console.log(`Created note for existing contact: ${toEmail.email} (contact ID: ${contact.id})`);
          
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
        // Contact doesn't exist - we'll create it when user views the email or manually
        // For now, just mark that we tried to match
        console.log(`No contact found for ${toEmail.email}, email stored but not linked`);
      }
    } catch (error) {
      console.error(`Error matching email to contact ${toEmail.email}:`, error);
    }
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
