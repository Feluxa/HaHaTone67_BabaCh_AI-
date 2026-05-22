export async function GET() {
  return Response.json({
    status: "ok",
    service: "bank-agent-ui",
    architecture: "next-route-handlers-plus-agent-core",
  });
}
