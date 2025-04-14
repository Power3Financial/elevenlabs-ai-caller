import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { registerOutboundRoutes } from './outbound-calls.js';
import { registerCalendlyRoutes } from './calendly.js';




dotenv.config();

const fastify = Fastify({ logger: true });

await registerCalendlyRoutes(fastify);

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Register routes
await registerOutboundRoutes(fastify);

// Root route
fastify.get("/", (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Start server
fastify.listen({ port: process.env.PORT || 8000, host: "0.0.0.0" }, (err, address) => {
  if (err) throw err;
  console.log(`Server listening at ${address}`);
});


