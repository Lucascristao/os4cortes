import crypto from "node:crypto";

function env(name: string): string {
  return ((globalThis as any).Netlify?.env?.get(name) || "").trim();
}

function base64url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeState(secret: string): string {
  const ts = Date.now().toString();
  const sig = crypto.createHmac("sha256", secret).update(ts).digest("hex");
  return base64url(`${ts}.${sig}`);
}

export default async (req: Request) => {
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    return new Response(
      "GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET ainda não foram configurados no Netlify.",
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }

  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/google-drive/callback`;
  const state = makeState(clientSecret);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

  return Response.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    302
  );
};

export const config = {
  path: "/api/google-drive/connect",
};
