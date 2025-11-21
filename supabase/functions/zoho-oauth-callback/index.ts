// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, createErrorResponse } from "../_shared/utils.ts";

const ZOHO_CLIENT_ID = Deno.env.get("ZOHO_CLIENT_ID");
const ZOHO_CLIENT_SECRET = Deno.env.get("ZOHO_CLIENT_SECRET");

const ZOHO_TOKEN_URLS: Record<string, string> = {
  us: "https://accounts.zoho.com/oauth/v2/token",
  eu: "https://accounts.zoho.eu/oauth/v2/token",
  in: "https://accounts.zoho.in/oauth/v2/token",
  au: "https://accounts.zoho.com.au/oauth/v2/token",
  jp: "https://accounts.zoho.jp/oauth/v2/token",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
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
    const { data: salesUser, error: salesError } = await supabaseAdmin
      .from("sales")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (salesError || !salesUser) {
      console.error("Sales user lookup error:", salesError);
      console.error("User ID:", user.id);
      return createErrorResponse(
        403,
        `Sales user not found. Please ensure your account has a sales record. Error: ${salesError?.message || "Unknown error"}`,
      );
    }

    if (req.method === "POST") {
      const { code, dataCenter = "eu", redirectUri } = await req.json();

      if (!code) {
        return createErrorResponse(400, "Authorization code is required");
      }

      if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
        return createErrorResponse(500, "Zoho OAuth is not configured");
      }

      try {
        // Exchange code for tokens
        const tokenUrl = ZOHO_TOKEN_URLS[dataCenter] || ZOHO_TOKEN_URLS.eu;
        // Use the redirectUri from request, or construct it from origin
        // IMPORTANT: This MUST match exactly what was used in the initial OAuth request
        // The redirect URI should point to the HTML file that handles the hash conversion
        const finalRedirectUri = redirectUri || `${req.headers.get("origin") || ""}/zoho-callback.html`;
        
        console.log("Token exchange parameters:", {
          codeLength: code.length,
          dataCenter,
          redirectUri: finalRedirectUri,
          tokenUrl,
        });
        const params = new URLSearchParams({
          code,
          client_id: ZOHO_CLIENT_ID,
          client_secret: ZOHO_CLIENT_SECRET,
          redirect_uri: finalRedirectUri,
          grant_type: "authorization_code",
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
          let errorData;
          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { error: errorText || "Failed to exchange code for tokens" };
          }
          console.error("Zoho token exchange failed:", errorData);
          console.error("Request details:", {
            codeLength: code.length,
            codePrefix: code.substring(0, 10),
            dataCenter,
            redirectUri: finalRedirectUri,
            tokenUrl,
            clientId: ZOHO_CLIENT_ID ? "present" : "missing",
            clientSecret: ZOHO_CLIENT_SECRET ? "present" : "missing",
          });
          
          // Provide more helpful error messages
          let errorMessage = errorData.error || errorData.message || "Failed to exchange code for tokens";
          if (errorData.error === "invalid_code") {
            errorMessage = `Invalid authorization code. This usually means:
1. The code has expired (codes expire quickly)
2. The redirect_uri doesn't match exactly
3. The code was already used
4. The client_id or client_secret is incorrect

Please try connecting again. Redirect URI used: ${finalRedirectUri}`;
          } else if (errorData.error === "invalid_client") {
            errorMessage = "Invalid client credentials. Please check ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in Supabase secrets.";
          } else if (errorData.error === "invalid_redirect_uri") {
            errorMessage = `Redirect URI mismatch. The redirect URI must match exactly what's configured in Zoho Developer Console. Used: ${finalRedirectUri}`;
          }
          
          return createErrorResponse(
            response.status,
            errorMessage,
          );
        }

        const responseText = await response.text();
        console.log("Zoho token response text:", responseText.substring(0, 500));
        
        let tokenData;
        try {
          tokenData = JSON.parse(responseText);
        } catch (parseError) {
          console.error("Failed to parse Zoho response as JSON:", parseError);
          console.error("Response text:", responseText);
          return createErrorResponse(500, `Invalid response from Zoho: ${responseText.substring(0, 200)}`);
        }

        console.log("Parsed token data:", {
          hasAccessToken: !!tokenData.access_token,
          hasRefreshToken: !!tokenData.refresh_token,
          expiresIn: tokenData.expires_in,
          error: tokenData.error,
          keys: Object.keys(tokenData),
        });

        // Check if Zoho returned an error in the response body
        if (tokenData.error) {
          console.error("Zoho returned error:", tokenData);
          return createErrorResponse(
            400,
            tokenData.error_description || tokenData.error || "Zoho OAuth error",
          );
        }

        // Validate that we have the required tokens
        if (!tokenData.access_token) {
          console.error("No access_token in Zoho response:", tokenData);
          return createErrorResponse(
            500,
            `Zoho did not return an access_token. Response: ${JSON.stringify(tokenData)}. This usually means the authorization code is invalid or expired, or the redirect_uri doesn't match.`,
          );
        }

        if (!tokenData.refresh_token) {
          console.warn("No refresh_token in Zoho response. This may be expected if the user already authorized.");
        }

        // Calculate expiration time
        const expiresAt = new Date();
        expiresAt.setSeconds(expiresAt.getSeconds() + (tokenData.expires_in || 3600));

        // Get account ID from Zoho Mail API
        // Zoho Mail API base URLs by data center
        const ZOHO_API_BASE_URLS: Record<string, string> = {
          us: "https://mail.zoho.com/api",
          eu: "https://mail.zoho.eu/api",
          in: "https://mail.zoho.in/api",
          au: "https://mail.zoho.com.au/api",
          jp: "https://mail.zoho.jp/api",
        };
        
        const apiBaseUrl = ZOHO_API_BASE_URLS[dataCenter] || ZOHO_API_BASE_URLS.us;
        let accountId: string | null = null;
        let accountEmail: string | null = null;
        
        try {
          // Fetch accounts to get account ID
          const accountsUrl = `${apiBaseUrl}/accounts`;
          console.log(`Fetching accounts from: ${accountsUrl}`);
          
          const accountsResponse = await fetch(accountsUrl, {
            headers: {
              Authorization: `Zoho-oauthtoken ${tokenData.access_token}`,
              "Content-Type": "application/json",
            },
          });

          if (accountsResponse.ok) {
            const accountsData: any = await accountsResponse.json();
            console.log(`Accounts API response:`, JSON.stringify(accountsData, null, 2));
            
            // According to Zoho Mail API docs, response is: { "data": [{ "accountId": "...", "accountDisplayName": "..." }] }
            if (accountsData?.data && Array.isArray(accountsData.data) && accountsData.data.length > 0) {
              const account = accountsData.data[0];
              accountId = account.accountId || account.id || account.account_id;
              accountEmail = account.accountDisplayName || account.displayName || account.email || account.account_email;
              console.log(`Found account ID: ${accountId}, email: ${accountEmail}`);
            }
          } else {
            const errorText = await accountsResponse.text();
            console.warn(`Failed to get accounts during OAuth: ${accountsResponse.status} - ${errorText.substring(0, 200)}`);
            // Don't fail the OAuth flow if we can't get account ID - we'll fetch it later
          }
        } catch (accountError) {
          console.error(`Error getting account ID during OAuth:`, accountError);
          // Don't fail the OAuth flow if we can't get account ID - we'll fetch it later
        }

        // Store tokens in database
        console.log("Storing tokens for sales_id:", salesUser.id);
        console.log("Token data received:", {
          hasAccessToken: !!tokenData.access_token,
          hasRefreshToken: !!tokenData.refresh_token,
          expiresIn: tokenData.expires_in,
          accountId,
          accountEmail,
        });

        const { data: insertedData, error: dbError } = await supabaseAdmin
          .from("zoho_oauth_tokens")
          .upsert({
            sales_id: salesUser.id,
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: expiresAt.toISOString(),
            data_center: dataCenter,
            account_id: accountId,
            account_email: accountEmail,
            updated_at: new Date().toISOString(),
          }, {
            onConflict: "sales_id",
          });

        if (dbError) {
          console.error("Database error details:", JSON.stringify(dbError, null, 2));
          console.error("Sales user ID:", salesUser.id);
          return createErrorResponse(500, `Failed to save tokens: ${dbError.message}. Code: ${dbError.code}`);
        }

        console.log("Tokens saved successfully. Inserted data:", insertedData);

        return new Response(
          JSON.stringify({
            success: true,
            message: "Zoho Mail connected successfully",
          }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
            status: 200,
          },
        );
      } catch (error) {
        console.error("OAuth callback error:", error);
        return createErrorResponse(
          500,
          error instanceof Error ? error.message : "Failed to process OAuth callback",
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

