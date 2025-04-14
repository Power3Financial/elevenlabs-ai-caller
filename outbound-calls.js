import WebSocket from "ws";
import Twilio from "twilio";
import fs from "fs";

const aiLogFile = "./ai_log.txt";

export function registerOutboundRoutes(fastify) {
    const {
        ELEVENLABS_API_KEY,
        ELEVENLABS_AGENT_ID,
        TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN,
        TWILIO_PHONE_NUMBER,
    } = process.env;

    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
        console.error("Missing required environment variables");
        throw new Error("Missing required environment variables");
    }

    const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    async function getSignedUrl() {
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
            {
                method: "GET",
                headers: { "xi-api-key": ELEVENLABS_API_KEY },
            }
        );
        if (!response.ok) {
            throw new Error(`Failed to get signed URL: ${response.statusText}`);
        }
        const data = await response.json();
        return data.signed_url;
    }

    function escapeXml(str) {
        return str.replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, " ")
            .replace(/\r/g, " ");
    }

    function truncate(str, maxLength = 2000) {
        return str.length > maxLength ? str.slice(0, maxLength) + "..." : str;
    }

    function buildPrompt(comments) {
        return `Instructions:
- The person you're calling opted in but we may not have spoken to them yet.
- You represent Power 3 Financial, a small agency that specializing in IULs.
- After the initial greeting from the caller say something along the lines of "This is Callie calling from Power 3 Financial. What did I catch you in the middle of?"
- If the lead doesn’t recognize the company, casually mention that we’re the team behind “Casey the Dollar” on TikTok.
- The lead could be a colder lead, a lead that has reached out about free training, or a lead that we've already spoken to. 
- Use Eriksonian NLP techniques to guide them toward booking a Zoom.
- Your main objective is to re-engage the lead to get them to book a Zoom call to walk through a personalized illustration.
- If they ask questions, reference the knowledge base (assume it includes IULs, cash value, tax-free loans, policy costs).
- If they object, acknowledge them empathetically and continue toward booking.
- If they say "Yes", "Sure", or "Okay" to a Zoom say "Great, I'll text you over a link to schedule a time that works best."
- Be warm, slightly confused at the start (like “Hey, is this [name]?”), then quickly become more professional and helpful.
- Your tone is calm, enthusiastic, slightly informal, and never robotic.
- Keep it very short and don't over explain.
- Make it friendly, confident, and slightly conversational — you can vary the script naturally. Try to sound like you're genuinely trying to reconnect, using the "confused old man" approach subtly to disarm.
- If you get a voicemai, leave a message saing: "Hey, this is Callie calling from Power Three Financial. You reached out about getting some more information about using IULs as a powerful tool to add to your financial strategy and I just wanted to get you the information you were looking for. If you could give me a call back or shoot me a text at 323-543-4797, that would be great. I look forward to hearing from you." end the call after leaving a voicemail, do not wait for a reponse..
- If you're unsure about anything, you may reference the Knowledge Base.

Additional context from internal notes:
${comments || 'No comments available.'}`;
    };

    fastify.post("/outbound-call", async (request, reply) => {
        const { number, first_message, comments, calendly_link } = request.body;
        if (!number || !first_message) {
            return reply.code(400).send({ error: "Missing number or first_message" });
        }
        try {
            const call = await twilioClient.calls.create({
                from: TWILIO_PHONE_NUMBER,
                to: number,
                url: `https://${request.hostname}/outbound-call-twiml?first_message=${encodeURIComponent(first_message)}&number=${encodeURIComponent(number)}&comments=${encodeURIComponent(comments || "")}&calendly_link=${encodeURIComponent(calendly_link || "")}`,
            });
            reply.send({ success: true, message: "Call initiated", callSid: call.sid });
        } catch (error) {
            console.error("Error initiating outbound call:", error);
            reply.code(500).send({ success: false, error: "Failed to initiate call" });
        }
    });

    fastify.all("/outbound-call-twiml", async (request, reply) => {
        const twimlResponse = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<Response>
  <Connect>
    <Stream url=\"wss://${request.headers.host}/outbound-media-stream\">
      <Parameter name=\"first_message\" value=\"${escapeXml(request.query.first_message || '')}\" />
      <Parameter name=\"number\" value=\"${escapeXml(request.query.number || '')}\" />
      <Parameter name=\"comments\" value=\"${escapeXml(request.query.comments || '')}\" />
      <Parameter name=\"calendly_link\" value=\"${escapeXml(request.query.calendly_link || '')}\" />
    </Stream>
  </Connect>
</Response>`;
        reply.type("text/xml").send(twimlResponse);
    });

    fastify.register(async (fastifyInstance) => {
        fastifyInstance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
            let streamSid = null;
            let callSid = null;
            let elevenLabsWs = null;
            let callData = null;
            let hasTexted = false;

            ws.on("error", console.error);

            const setupElevenLabs = async () => {
                try {
                    const signedUrl = await getSignedUrl();
                    elevenLabsWs = new WebSocket(signedUrl);

                    elevenLabsWs.on("open", () => {
                        const prompt = buildPrompt(truncate(callData.comments || ""));
                        const initialConfig = {
                            type: "conversation_initiation_client_data",
                            conversation_config_override: {
                                agent: {
                                    prompt: { prompt },
                                    first_message: callData.first_message || "Hey there! How can I help you today?",
                                    agent_name: "Callie",
                                },
                                user_context: { phone: callData.number },
                            },
                        };
                        elevenLabsWs.send(JSON.stringify(initialConfig));
                    });

                    elevenLabsWs.on("message", (data) => {
                        let message;
                        try {
                            const json = typeof data === "string" ? data : data.toString("utf8");
                            message = JSON.parse(json);
                        } catch (err) {
                            console.error("[ElevenLabs] Failed to parse message:", err);
                            return;
                        }

                        function triggerFollowupSms() {
                            hasTexted = true;
                            const link = callData?.calendly_link || "https://calendly.com/d/cprr-9rv-bt9/strategic-assessment-call";
                            const number = callData?.number;

                            if (number && link) {
                                twilioClient.messages
                                    .create({
                                        from: TWILIO_PHONE_NUMBER,
                                        to: number,
                                        body: `Here's the link to schedule a Zoom call: ${link}`,
                                    })
                                    .then((msg) => console.log("[Twilio] ✅ SMS sent:", msg.sid))
                                    .catch((err) => console.error("[Twilio] ❌ SMS error:", err));
                            } else {
                                console.warn("[SMS] Missing number or link, skipping text.");
                            }
                        }


                        const triggerRegex = /\b(i['’]ll|i\s+will|i’m\s+going\s+to|let\s+me)\b.*\b(send|text)\b.*\b(link|calendar|schedule|zoom|invite)\b/;

                        switch (message.type) {
                            case "text_event":
                                const textEventText = message.text_event?.text?.toLowerCase?.() || "";
                                fs.appendFileSync(aiLogFile, `[${new Date().toISOString()}] ${textEventText}\n`);
                                console.log(`🗣️ [AI said]: ${textEventText}`);

                                if (!hasTexted && triggerRegex.test(textEventText)) {
                                    triggerFollowupSms();
                                }
                                break;

                            case "agent_response":
                                const responseText = message.agent_response?.text?.toLowerCase?.() || "";
                                console.log(`🤖 [Agent Response]: ${responseText}`);

                                if (!hasTexted && triggerRegex.test(responseText)) {
                                    triggerFollowupSms();
                                }
                                break;

                            case "agent_response":
                                console.log(`🤖 [Agent Response]: ${message.agent_response?.text?.trim()}`);
                                break;
                            case "user_transcript":
                                console.log(`🧑 [User Said]: ${message.user_transcript?.text?.trim()}`);
                                break;
                            case "interruption":
                                console.log("⚠️ [AI interruption]");
                                if (streamSid) ws.send(JSON.stringify({ event: "clear", streamSid }));
                                break;
                            case "ping":
                                if (message.ping_event?.event_id) {
                                    elevenLabsWs.send(JSON.stringify({ type: "pong", event_id: message.ping_event.event_id }));
                                }
                                break;
                            case "audio":
                                const payload = message.audio?.chunk || message.audio_event?.audio_base_64;
                                if (streamSid && payload) {
                                    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
                                }
                                break;
                            default:
                                console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
                                if (message.agent_response) {
                                    console.log(`[Debug] Full agent_response:`, JSON.stringify(message.agent_response, null, 2));
                                }
                                if (message.text_event) {
                                    console.log(`[Debug] Full text_event:`, JSON.stringify(message.text_event, null, 2));
                                }

                                break;
                        }
                    });

                    elevenLabsWs.on("error", err => console.error("[ElevenLabs] WebSocket error:", err));
                    elevenLabsWs.on("close", () => console.log("[ElevenLabs] Disconnected"));
                } catch (err) {
                    console.error("[ElevenLabs] Setup error:", err);
                }
            };

            setupElevenLabs();

            ws.on("message", (message) => {
                try {
                    const decoded = typeof message === "string" ? message : message.toString("utf8");
                    const msg = JSON.parse(decoded);

                    if (msg.event !== "media") {
                        console.log(`[Twilio → AI] Event received: ${msg.event}`);
                    }

                    switch (msg.event) {
                        case "start":
                            streamSid = msg.start.streamSid;
                            callSid = msg.start.callSid;
                            callData = msg.start.customParameters;
                            console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
                            break;
                        case "media":
                            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                                elevenLabsWs.send(JSON.stringify({ user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64") }));
                            }
                            break;
                        case "stop":
                            console.log(`[Twilio] Stream ${streamSid} ended`);
                            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                                elevenLabsWs.close();
                            }
                            break;
                        default:
                            console.log(`[Twilio] Unhandled event: ${msg.event}`);
                    }
                } catch (err) {
                    console.error("[Server] Failed to decode or parse Twilio message:", err);
                }
            });

            ws.on("close", () => {
                console.log("[Twilio] Client disconnected");
                if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                    elevenLabsWs.close();
                }
            });
        });
    });
}
