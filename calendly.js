import dotenv from "dotenv";
dotenv.config();

// ✅ Define the correct event type URI at the top
const eventTypeUri = "https://api.calendly.com/event_types/756aff18-0f29-4207-8e3d-0bda89471dc9"; // 45-min Zoom Meeting

export async function registerCalendlyRoutes(fastify) {
  // Get the authenticated user's URI
  fastify.get("/calendly-user", async (_, reply) => {
    try {
      const response = await fetch("https://api.calendly.com/users/me", {
        headers: {
          Authorization: `Bearer ${process.env.CALENDLY_API_KEY}`,
        },
      });

      const data = await response.json();
      console.log("[Calendly] Fetched user URI:", data.resource.uri);
      reply.send({ user_uri: data.resource.uri });
    } catch (error) {
      console.error("[Calendly] Failed to get user URI:", error);
      reply.code(500).send({ error: "Failed to fetch Calendly user URI" });
    }
  });

}
