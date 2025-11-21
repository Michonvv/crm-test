import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { supabase } from "../providers/supabase/supabase";

const ZOHO_DATA_CENTER = import.meta.env.VITE_ZOHO_DATA_CENTER || "eu";

export const ZohoMailCallback = () => {
  // IMMEDIATE LOG - if you see this, component is rendering
  console.log("🚨 ZOHO CALLBACK COMPONENT RENDERED 🚨");
  console.log("Current pathname:", window.location.pathname);
  console.log("Current href:", window.location.href);
  console.log("Current hash:", window.location.hash);
  
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");
  const [debugInfo, setDebugInfo] = useState<string[]>([]);

  const addDebug = (msg: string) => {
    console.log(msg);
    setDebugInfo(prev => [...prev, `${new Date().toLocaleTimeString()}: ${msg}`]);
  };

  useEffect(() => {
    addDebug("=== ZohoMailCallback component mounted ===");
    addDebug(`Current URL: ${window.location.href}`);
    addDebug(`Window location pathname: ${window.location.pathname}`);
    addDebug(`Window location search: ${window.location.search}`);
    addDebug(`Window location hash: ${window.location.hash}`);
    
    // Handle OAuth redirect: Zoho redirects to /zoho-callback?code=... (path-based, no hash)
    // But react-admin uses hash routing (#/zoho-callback)
    // If we're on path-based URL, extract code and process it directly
    // If we're on hash-based URL, extract from hash
    
    let code: string | null = null;
    let error: string | null = null;
    
    if (window.location.pathname === "/zoho-callback") {
      // Path-based redirect from Zoho (no hash)
      addDebug("Detected path-based redirect (from Zoho OAuth)");
      const searchParams = new URLSearchParams(window.location.search);
      code = searchParams.get("code");
      error = searchParams.get("error");
    } else if (window.location.hash.includes("/zoho-callback")) {
      // Hash-based route (react-admin routing)
      addDebug("Detected hash-based route (react-admin routing)");
      const hashParams = window.location.hash.includes("?") 
        ? new URLSearchParams(window.location.hash.split("?")[1])
        : null;
      code = hashParams?.get("code") || null;
      error = hashParams?.get("error") || null;
    } else {
      // Fallback: try both
      const searchParams = new URLSearchParams(window.location.search);
      const hashParams = window.location.hash.includes("?") 
        ? new URLSearchParams(window.location.hash.split("?")[1])
        : null;
      code = hashParams?.get("code") || searchParams.get("code");
      error = hashParams?.get("error") || searchParams.get("error");
    }
    
    addDebug(`Code from URL: ${code ? code.substring(0, 30) + "..." : "MISSING"}`);
    addDebug(`Error from URL: ${error || "None"}`);
    addDebug(`VITE_SUPABASE_URL: ${import.meta.env.VITE_SUPABASE_URL || "MISSING!"}`);
    addDebug(`VITE_SUPABASE_ANON_KEY: ${import.meta.env.VITE_SUPABASE_ANON_KEY ? "SET" : "MISSING!"}`);

    const handleCallback = async () => {
      try {
        if (error) {
          setStatus("error");
          setMessage(`OAuth error from Zoho: ${error}`);
          addDebug(`OAuth error: ${error}`);
          return;
        }

        if (!code) {
          setStatus("error");
          setMessage("No authorization code received from Zoho");
          addDebug("ERROR: No code in URL");
          return;
        }

        if (!import.meta.env.VITE_SUPABASE_URL) {
          setStatus("error");
          setMessage("Configuration error: VITE_SUPABASE_URL is not set");
          addDebug("ERROR: VITE_SUPABASE_URL missing");
          return;
        }

        if (!import.meta.env.VITE_SUPABASE_ANON_KEY) {
          setStatus("error");
          setMessage("Configuration error: VITE_SUPABASE_ANON_KEY is not set");
          addDebug("ERROR: VITE_SUPABASE_ANON_KEY missing");
          return;
        }

        // Exchange code for tokens via backend (secure - client secret stays on server)
        addDebug("Getting Supabase session...");
        const session = await supabase.auth.getSession();
        const sessionToken = session.data.session?.access_token;

        addDebug(`Session token: ${sessionToken ? "FOUND" : "MISSING"}`);

        if (!sessionToken) {
          setStatus("error");
          setMessage("Not authenticated. Your session may have expired during the redirect. Please try logging in again.");
          addDebug("ERROR: No session token");
          return;
        }

        const functionUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zoho-oauth-callback`;
        // IMPORTANT: This MUST match exactly what was used in ZohoMailConnect.tsx
        // The redirect URI used in token exchange must match the one used in the initial OAuth request
        const redirectUri = `${window.location.origin}/zoho-callback.html`;

        addDebug(`Calling edge function: ${functionUrl}`);
        addDebug(`Redirect URI: ${redirectUri}`);
        addDebug(`Data center: ${ZOHO_DATA_CENTER}`);
        addDebug(`Session token length: ${sessionToken?.length || 0}`);
        addDebug(`Anon key present: ${!!import.meta.env.VITE_SUPABASE_ANON_KEY}`);

        const requestBody = {
          code,
          dataCenter: ZOHO_DATA_CENTER,
          redirectUri,
        };

        addDebug(`Request body prepared (code length: ${code.length})`);

        // Test if the URL is reachable first
        addDebug("Testing function URL reachability with OPTIONS...");
        try {
          const testResponse = await fetch(functionUrl, {
            method: "OPTIONS",
            headers: {
              "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY || "",
              "Content-Type": "application/json",
            },
          });
          addDebug(`OPTIONS test response: ${testResponse.status} ${testResponse.statusText}`);
          if (!testResponse.ok && testResponse.status !== 204) {
            addDebug(`WARNING: OPTIONS returned ${testResponse.status}`);
          }
        } catch (testError: any) {
          addDebug(`OPTIONS test FAILED: ${testError.message}`);
          addDebug(`Error name: ${testError.name}`);
          addDebug(`Error stack: ${testError.stack?.substring(0, 200)}`);
          // Don't throw here - continue to try POST anyway
          addDebug("Continuing with POST request despite OPTIONS failure...");
        }

        addDebug("Sending POST request to edge function...");
        addDebug(`Full request URL: ${functionUrl}`);
        addDebug(`Request headers: apikey=${!!import.meta.env.VITE_SUPABASE_ANON_KEY}, Authorization=${!!sessionToken}`);
        
        let response;
        try {
          response = await fetch(functionUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY || "",
              "Authorization": `Bearer ${sessionToken}`,
            },
            body: JSON.stringify(requestBody),
          });
          addDebug(`Response received: ${response.status} ${response.statusText}`);
        } catch (fetchError: any) {
          addDebug(`FETCH ERROR: ${fetchError.message}`);
          addDebug(`Error type: ${fetchError.name}`);
          addDebug(`Error cause: ${fetchError.cause || "Unknown"}`);
          addDebug(`Full error: ${JSON.stringify(fetchError, Object.getOwnPropertyNames(fetchError))}`);
          
          // More specific error messages
          if (fetchError.message.includes("Failed to fetch") || fetchError.message.includes("NetworkError")) {
            addDebug("This is a network error. Possible causes:");
            addDebug("  1. CORS is blocking the request (check browser console)");
            addDebug("  2. Function is not accessible from this origin");
            addDebug("  3. Network connectivity issue");
            addDebug("  4. Function URL is incorrect");
            throw new Error(`Network error: Cannot reach edge function. Check browser console (F12) for CORS errors. URL: ${functionUrl}`);
          }
          
          throw new Error(`Failed to call edge function: ${fetchError.message}. Check if the function is deployed and the URL is correct.`);
        }

        const responseText = await response.text();
        addDebug(`Response body: ${responseText.substring(0, 200)}`);

        if (!response.ok) {
          let errorData;
          try {
            errorData = JSON.parse(responseText);
          } catch {
            errorData = { message: responseText || `HTTP ${response.status}` };
          }
          addDebug(`ERROR: ${JSON.stringify(errorData)}`);
          // Edge function returns { status, message } format
          const errorMessage = errorData.message || errorData.status || `Failed to exchange code for tokens (${response.status})`;
          throw new Error(errorMessage);
        }

        let result;
        try {
          result = JSON.parse(responseText);
        } catch (e) {
          addDebug(`ERROR: Failed to parse response as JSON: ${responseText}`);
          throw new Error(`Invalid response from server: ${responseText.substring(0, 100)}`);
        }

        addDebug(`Parsed response: ${JSON.stringify(result)}`);

        // Handle both { success: true } and { status, message } response formats
        if (result.status && !result.success) {
          throw new Error(result.message || "Failed to connect Zoho Mail");
        }

        if (result.success === false) {
          throw new Error(result.message || "Failed to connect Zoho Mail");
        }

        if (!result.success && !result.status) {
          // If response is 200 but doesn't have success field, assume it worked
          addDebug("Response doesn't have success field, but status is 200 - assuming success");
        }

        setStatus("success");
        setMessage("Zoho Mail connected successfully! Redirecting...");
        addDebug("SUCCESS: Tokens stored in database");

        // Invalidate the zohoToken query cache so it refetches
        queryClient.invalidateQueries({ queryKey: ["zohoToken"] });

        // Redirect back to the contact page or contacts list
        const returnTo = sessionStorage.getItem("zoho_oauth_return_to") || "/contacts";
        sessionStorage.removeItem("zoho_oauth_return_to");
        addDebug(`Redirecting to: ${returnTo}`);
        setTimeout(() => {
          navigate(returnTo);
        }, 1500);
      } catch (error: any) {
        addDebug(`EXCEPTION: ${error.message || String(error)}`);
        if (error.stack) {
          addDebug(`Stack: ${error.stack.substring(0, 200)}`);
        }
        setStatus("error");
        setMessage(error.message || "Failed to connect Zoho Mail. Check debug info below.");
      }
    };

    handleCallback();
  }, [navigate, queryClient]);

  console.log("ZohoMailCallback render - status:", status, "message:", message);

  const testFunction = async () => {
    addDebug("=== MANUAL TEST BUTTON CLICKED ===");
    const functionUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zoho-oauth-callback`;
    addDebug(`Testing: ${functionUrl}`);
    
    try {
      const test = await fetch(functionUrl, {
        method: "OPTIONS",
        headers: { "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY || "" },
      });
      addDebug(`Manual test result: ${test.status} ${test.statusText}`);
      setMessage(`Function is reachable! Status: ${test.status}`);
    } catch (e: any) {
      addDebug(`Manual test FAILED: ${e.message}`);
      setMessage(`Function NOT reachable: ${e.message}`);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      {/* BIG RED BANNER - if you see this, component is rendering */}
      <div className="fixed top-0 left-0 right-0 bg-red-600 text-white p-2 text-center z-50 font-bold">
        🚨 ZOHO CALLBACK PAGE IS RENDERING 🚨
      </div>
      <Card className="w-full max-w-2xl">
        <CardContent className="pt-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              Status: <strong>{status}</strong>
            </div>
            <Button onClick={testFunction} size="sm" variant="outline">
              Test Function Connection
            </Button>
          </div>
          {status === "loading" && (
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
              <p>Connecting Zoho Mail...</p>
              <p className="text-xs text-muted-foreground mt-2">
                Processing OAuth callback...
              </p>
            </div>
          )}

          {status === "success" && (
            <Alert>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}

          {status === "error" && (
            <div className="space-y-4">
              <Alert variant="destructive">
                <AlertDescription>
                  <div className="space-y-2">
                    <p className="font-semibold">Error connecting Zoho Mail:</p>
                    <p className="font-mono text-sm">{message}</p>
                  </div>
                </AlertDescription>
              </Alert>
              <Button onClick={() => navigate("/contacts")} className="w-full">
                Go to Contacts
              </Button>
            </div>
          )}

          {/* Debug Info Panel */}
          <div className="mt-6 p-4 bg-muted rounded-lg">
            <p className="text-xs font-semibold mb-2">Debug Log:</p>
            <div className="max-h-64 overflow-y-auto text-xs font-mono space-y-1">
              {debugInfo.length === 0 ? (
                <p className="text-muted-foreground">Waiting for debug info...</p>
              ) : (
                debugInfo.map((info, idx) => (
                  <div key={idx} className="text-muted-foreground">{info}</div>
                ))
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

