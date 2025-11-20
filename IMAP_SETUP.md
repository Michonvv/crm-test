# IMAP Email Sync Setup

This guide explains how to set up the IMAP email sync feature for Atomic CRM.

## Overview

The IMAP sync feature replaces the Postmark inbound email solution. It:
- Fetches unread emails from your IMAP inbox
- Processes them and adds notes to contacts
- Can be triggered manually via a sync button
- Can be scheduled to run automatically every 2 hours via cron

## Setup Steps

### 1. Set IMAP Credentials as Supabase Secrets

Run these commands to set your IMAP credentials:

```bash
npx supabase secrets set IMAP_HOST=imap.gmail.com
npx supabase secrets set IMAP_PORT=993
npx supabase secrets set IMAP_USER=your-email@gmail.com
npx supabase secrets set IMAP_PASSWORD=your-app-password
npx supabase secrets set IMAP_USE_TLS=true
npx supabase secrets set IMAP_SYNC_AUTH_TOKEN=your-secret-token-here
```

**Important Notes:**
- For Gmail, use an [App Password](https://support.google.com/accounts/answer/185833) instead of your regular password
- For other providers, check their IMAP settings:
  - **Gmail**: `imap.gmail.com:993` (TLS)
  - **Outlook/Hotmail**: `outlook.office365.com:993` (TLS)
  - **Yahoo**: `imap.mail.yahoo.com:993` (TLS)
  - **Custom**: Check your email provider's documentation

### 2. Set Frontend Environment Variable (Optional)

If you want to secure the sync button with authentication, add to your `.env.local`:

```
VITE_IMAP_SYNC_AUTH_TOKEN=your-secret-token-here
```

This should match the `IMAP_SYNC_AUTH_TOKEN` you set in Supabase secrets.

### 3. Deploy the Edge Function

```bash
npx supabase functions deploy imap-sync
```

### 4. Test the Sync Button

1. Go to Settings in the CRM
2. Click the "Sync Emails" button
3. Check the notification for results

### 5. Set Up Cron Job (Every 2 Hours)

You can use any cron service to call the Edge Function every 2 hours. Here are some options:

#### Option A: Using cron-job.org (Free)

1. Go to [cron-job.org](https://cron-job.org/)
2. Create a free account
3. Add a new cron job:
   - **URL**: `https://wcdrzxibyrlltbgvilds.supabase.co/functions/v1/imap-sync`
   - **Schedule**: `0 */2 * * *` (every 2 hours)
   - **Request Method**: POST
   - **Headers**: 
     - `Authorization: Bearer your-secret-token-here`
     - `Content-Type: application/json`

#### Option B: Using EasyCron (Free tier available)

1. Go to [EasyCron](https://www.easycron.com/)
2. Create a cron job with:
   - **URL**: `https://wcdrzxibyrlltbgvilds.supabase.co/functions/v1/imap-sync`
   - **Schedule**: Every 2 hours
   - **Method**: POST
   - **Headers**: `Authorization: Bearer your-secret-token-here`

#### Option C: Using GitHub Actions (If you have the repo)

Create `.github/workflows/imap-sync.yml`:

```yaml
name: IMAP Email Sync

on:
  schedule:
    - cron: '0 */2 * * *'  # Every 2 hours
  workflow_dispatch:  # Allow manual trigger

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger IMAP Sync
        run: |
          curl -X POST \
            -H "Authorization: Bearer ${{ secrets.IMAP_SYNC_AUTH_TOKEN }}" \
            https://wcdrzxibyrlltbgvilds.supabase.co/functions/v1/imap-sync
```

Add `IMAP_SYNC_AUTH_TOKEN` to your GitHub repository secrets.

## How It Works

1. The Edge Function connects to your IMAP server
2. Searches for unread emails in the INBOX
3. For each email:
   - Extracts sender (From) and recipients (To)
   - Creates/updates contacts based on recipient emails
   - Adds the email content as a note to the contact
   - Marks the email as read
4. Returns a summary of processed emails

## Troubleshooting

### "IMAP connection error"
- Check your IMAP_HOST and IMAP_PORT are correct
- Verify IMAP is enabled in your email account settings
- For Gmail, make sure you're using an App Password

### "IMAP login failed"
- Verify IMAP_USER and IMAP_PASSWORD are correct
- For Gmail, ensure you're using an App Password, not your regular password
- Check if 2FA is enabled and you've generated an app-specific password

### "No emails processed"
- Check if there are actually unread emails in your inbox
- Verify the email format is correct (proper To/From headers)

### Function timeout
- The function has a 60-second timeout limit
- If you have many emails, they'll be processed in batches
- Consider running sync more frequently with fewer emails

## Security Notes

- Never commit IMAP credentials to git
- Use strong, unique tokens for `IMAP_SYNC_AUTH_TOKEN`
- Consider using environment-specific tokens for different environments
- The auth token protects the endpoint from unauthorized access

