exports.handler = async () => ({
  statusCode: 302,
  multiValueHeaders: {
    "Set-Cookie": [
      "os4_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      "os4_setup=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    ],
  },
  headers: {
    Location: "/",
    "Cache-Control": "no-store",
  },
  body: "",
});
