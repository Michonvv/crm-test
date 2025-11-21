import React from "react";

interface EmailFormattedTextProps {
  text: string;
}

/**
 * Formats email content with proper styling for replies and quoted text
 */
export const EmailFormattedText: React.FC<EmailFormattedTextProps> = ({ text }) => {
  if (!text) return null;

  const lines = text.split("\n");
  
  // Check if this looks like an email (has subject line and possibly quoted text)
  const hasQuotedText = lines.some(line => line.trim().startsWith(">"));
  const hasReplyPattern = /^On\s+.+\s+wrote:?$/i.test(lines.find(l => l.trim()) || "");
  
  // If it doesn't look like an email, render normally
  if (!hasQuotedText && !hasReplyPattern) {
    return (
      <div className="[&_p:empty]:min-h-[0.75em]">
        {lines.map((paragraph: string, index: number) => (
          <p className="text-sm leading-6 m-0" key={index}>
            {paragraph}
          </p>
        ))}
      </div>
    );
  }

  // Parse email structure
  let subject = "";
  let replyText: string[] = [];
  let quotedText: string[] = [];
  let inQuotedSection = false;
  let foundReplySeparator = false;
  let subjectFound = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // First non-empty line is usually the subject (check first 5 lines)
    if (!subjectFound && trimmed && i < 5) {
      // Skip if it looks like it's already part of the email body (starts with common email patterns)
      if (!trimmed.startsWith(">") && !/^On\s+.+\s+wrote:?$/i.test(trimmed) && !/^On\s+.+wrote:?$/i.test(trimmed)) {
        subject = trimmed;
        subjectFound = true;
        continue; // Skip the subject line itself
      }
    }
    
    // Check for reply separator pattern (e.g., "On Fri, Jun 27, 2025 at 11:46 AM Michon <michon@guestri.com> wrote:")
    // This pattern can span multiple lines or be on a single line
    if (/^On\s+.+\s+wrote:?$/i.test(trimmed) || /^On\s+.+wrote:?$/i.test(trimmed)) {
      foundReplySeparator = true;
      inQuotedSection = true;
      // Add separator to quoted section
      quotedText.push(line);
      continue;
    }
    
    // Once we find the separator, everything after is quoted
    if (foundReplySeparator) {
      quotedText.push(line);
      continue;
    }
    
    // Check if line starts with ">" (quoted text)
    // This indicates we're in the quoted section
    if (trimmed.startsWith(">")) {
      inQuotedSection = true;
      quotedText.push(line);
      continue;
    }
    
    // If we're already in quoted section (found ">" before), continue adding to quoted
    if (inQuotedSection) {
      // If we hit a non-empty line that doesn't start with ">", 
      // check if previous lines were quoted - if so, this might still be part of quoted
      if (trimmed) {
        // If previous line was quoted, this might be continuation (some clients don't quote every line)
        if (i > 0 && lines[i - 1].trim().startsWith(">")) {
          quotedText.push(line);
          continue;
        }
        // If we have substantial quoted text and hit unquoted content, we might have reached end
        // But be conservative - if we have quoted text, assume everything after first quote is quoted
        quotedText.push(line);
        continue;
      } else {
        // Empty line in quoted section
        quotedText.push(line);
        continue;
      }
    }
    
    // If we're not in quoted section, it's reply text
    // (including empty lines after subject)
    if (!inQuotedSection) {
      replyText.push(line);
    }
  }

  // If we didn't find a clear structure, fall back to simple formatting
  if (replyText.length === 0 && quotedText.length === 0) {
    return (
      <div className="[&_p:empty]:min-h-[0.75em]">
        {lines.map((paragraph: string, index: number) => (
          <p className="text-sm leading-6 m-0" key={index}>
            {paragraph}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="email-formatted space-y-4">
      {/* Subject */}
      {subject && (
        <div className="border-b border-border pb-2">
          <h4 className="text-sm font-semibold text-foreground m-0">{subject}</h4>
        </div>
      )}
      
      {/* Reply text */}
      {replyText.length > 0 && (
        <div className="reply-section">
          <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
            Reply
          </div>
          <div className="[&_p:empty]:min-h-[0.75em]">
            {replyText.map((paragraph: string, index: number) => (
              <p className="text-sm leading-6 m-0" key={`reply-${index}`}>
                {paragraph}
              </p>
            ))}
          </div>
        </div>
      )}
      
      {/* Quoted/original email */}
      {quotedText.length > 0 && (
        <div className="quoted-section">
          <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
            Original Message
          </div>
          <div className="bg-muted/30 border-l-4 border-muted-foreground/30 pl-4 py-2 rounded-r">
            <div className="[&_p:empty]:min-h-[0.75em]">
              {quotedText.map((line: string, index: number) => {
                // Remove leading ">" and preserve spacing
                const cleanedLine = line.replace(/^>\s?/, "");
                const trimmed = cleanedLine.trim();
                
                // Handle the "On ... wrote:" separator - style it differently
                if (/^On\s+.+\s+wrote:?$/i.test(trimmed) || /^On\s+.+wrote:?$/i.test(trimmed)) {
                  return (
                    <div key={`quoted-sep-${index}`} className="text-xs text-muted-foreground/70 font-medium mb-2 mt-2">
                      {trimmed}
                    </div>
                  );
                }
                
                // Empty lines
                if (!trimmed) {
                  return <br key={`quoted-${index}`} />;
                }
                
                return (
                  <p className="text-sm leading-6 m-0 text-muted-foreground" key={`quoted-${index}`}>
                    {cleanedLine}
                  </p>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

