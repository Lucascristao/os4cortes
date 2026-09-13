const crypto = require("crypto");

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeState(secret) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac("sha256", secret).update(ts).digest("hex");
  return base64url(`${ts}.${sig}`);
}

exports.handler = async (event) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      statusCode: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET ainda não foram configurados no Netlify.",
    };
  }

  const host = event.headers["x-forwarded-host"] || event.headers.host || "os4cortes.netlify.app";
  const proto = event.headers["x-forwarded-proto"] || "https";
  const redirectUri = `${proto}://${host}/api/google-drive/callback`;
  const state = makeState(clientSecret);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive.file",
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

  return {
    statusCode: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      "Cache-Control": "no-store",
    },
    body: "",
  };
};
