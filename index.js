// Simple CloudNote Worker - ES Module format

// Basic CORS headers
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  
  // Handle OPTIONS requests for CORS
  function handleOptions(request) {
    return new Response(null, {
      headers: {
        ...corsHeaders,
        "Allow": "GET, POST, PUT, DELETE, OPTIONS"
      }
    });
  }
  
  // Main request handler
  async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    // Inside handleRequest function, add near the beginning:
    if (path === "/" || path === "") {
        return new Response(`
        <html>
            <head><title>CloudNote API</title></head>
            <body>
            <h1>CloudNote API is running!</h1>
            <p>This is the API server for CloudNote. The frontend should be deployed separately.</p>
            <p>Try accessing an API endpoint like <a href="/api/notes">/api/notes</a></p>
            </body>
        </html>
        `, {
        headers: {
            "Content-Type": "text/html"
        }
        });
    }
  
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }
  
    // WebSocket handling for real-time collaboration
    if (path.startsWith("/ws")) {
      return handleWebSocket(request, env);
    }
  
    // API routes
    if (path.startsWith("/api/notes")) {
      if (request.method === "GET") {
        return handleGetNotes(request, env);
      }
    }
  
    if (path.startsWith("/api/note")) {
      if (path === "/api/note/create" && request.method === "POST") {
        return handleCreateNote(request, env);
      }
      
      const noteId = path.split("/")[3];
      if (noteId) {
        if (request.method === "GET") {
          return handleGetNote(noteId, env);
        }
        if (request.method === "PUT") {
          return handleUpdateNote(noteId, request, env);
        }
        if (request.method === "DELETE") {
          return handleDeleteNote(noteId, env);
        }
        if (path.endsWith("/summarize") && request.method === "POST") {
            return handleSummarizeNote(noteId, request, env);
        }
      }
    }
  
    return new Response("Not found", { 
      status: 404,
      headers: corsHeaders
    });
  }
  
  // Handle WebSocket connections
  async function handleWebSocket(request, env) {
    const url = new URL(request.url);
    const noteId = url.pathname.split("/")[2];
    const clientId = url.searchParams.get("clientId") || "anonymous";
    
    if (!noteId) {
      return new Response("Note ID required", { status: 400 });
    }
    
    // Get Durable Object for this note
    const id = env.NOTES_DO.idFromName(noteId);
    const noteDO = env.NOTES_DO.get(id);
    
    // Forward request to Durable Object
    return noteDO.fetch(new Request(url.toString(), {
      headers: request.headers,
      cf: {
        // This magic tells workers to upgrade the connection to a websocket
        websocket: request.headers.get("Upgrade") === "websocket" ? {} : null
      }
    }));
  }
  
  // Get all notes
  async function handleGetNotes(request, env) {
    try {
      const bucket = env.NOTES;
      const listing = await bucket.list();
      
      const notes = await Promise.all(listing.objects.map(async obj => {
        const metadata = await bucket.head(obj.key);
        return {
          id: obj.key,
          title: metadata.customMetadata?.title || "Untitled Note",
          updatedAt: obj.uploaded
        };
      }));
      
      return new Response(JSON.stringify(notes), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
  }
  
  // Get a single note
  async function handleGetNote(noteId, env) {
    try {
      const bucket = env.NOTES;
      const note = await bucket.get(noteId);
      
      if (!note) {
        return new Response(JSON.stringify({ error: "Note not found" }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }
      
      const content = await note.text();
      
      return new Response(JSON.stringify({
        id: noteId,
        title: note.customMetadata?.title || "Untitled Note",
        content,
        createdAt: note.customMetadata?.createdAt,
        updatedAt: note.customMetadata?.updatedAt
      }), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
  }
  
  // Create a new note
  async function handleCreateNote(request, env) {
    try {
      const data = await request.json();
      
      if (!data) {
        return new Response(JSON.stringify({ error: "Invalid request data" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }
      
      const { title = "Untitled Note", content = "", clientId } = data;
      const timestamp = new Date().toISOString();
      const noteId = "note_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
      
      const bucket = env.NOTES;
      await bucket.put(noteId, content || "", {
        customMetadata: {
          title,
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: clientId || "anonymous"
        }
      });
      
      // Initialize the Durable Object
      const id = env.NOTES_DO.idFromName(noteId);
      const noteDO = env.NOTES_DO.get(id);
      
      await noteDO.fetch("https://internal/init", {
        method: "POST",
        body: JSON.stringify({
          id: noteId,
          title,
          content
        })
      });
      
      return new Response(JSON.stringify({
        id: noteId,
        title,
        content,
        createdAt: timestamp,
        updatedAt: timestamp
      }), {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
  }
  
  // Update an existing note
  async function handleUpdateNote(noteId, request, env) {
    try {
      const data = await request.json();
      
      if (!data) {
        return new Response(JSON.stringify({ error: "Invalid request data" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }
      
      const { title, content, clientId } = data;
      const bucket = env.NOTES;
      
      // Check if note exists
      const existingNote = await bucket.head(noteId);
      if (!existingNote) {
        return new Response(JSON.stringify({ error: "Note not found" }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }
      
      const timestamp = new Date().toISOString();
      const metadata = existingNote.customMetadata;
      
      // Update note in R2
      await bucket.put(noteId, content !== undefined ? content : await (await bucket.get(noteId)).text(), {
        customMetadata: {
          title: title !== undefined ? title : metadata.title,
          createdAt: metadata.createdAt,
          updatedAt: timestamp,
          updatedBy: clientId || "anonymous"
        }
      });
      
      // Update in Durable Object
      const id = env.NOTES_DO.idFromName(noteId);
      const noteDO = env.NOTES_DO.get(id);
      
      await noteDO.fetch("https://internal/update", {
        method: "POST",
        body: JSON.stringify({
          title: title !== undefined ? title : metadata.title,
          content: content !== undefined ? content : null,
          clientId
        })
      });
      
      return new Response(JSON.stringify({
        id: noteId,
        title: title !== undefined ? title : metadata.title,
        updatedAt: timestamp
      }), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
  }
  
  // Delete a note
  async function handleDeleteNote(noteId, env) {
    try {
      const bucket = env.NOTES;
      
      // Check if note exists
      const exists = await bucket.head(noteId);
      if (!exists) {
        return new Response(JSON.stringify({ error: "Note not found" }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }
      
      // Delete from R2
      await bucket.delete(noteId);
      
      // Delete from Durable Object (or at least notify it)
      const id = env.NOTES_DO.idFromName(noteId);
      const noteDO = env.NOTES_DO.get(id);
      
      await noteDO.fetch("https://internal/delete", {
        method: "POST"
      });
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
  }
  
  // ADD THE NEW FUNCTION HERE:
  // Summarize a note using Workers AI
  async function handleSummarizeNote(noteId, request, env) {
    try {
      // Get request body
      const data = await request.json();
      
      if (!data || !data.content) {
        return new Response(JSON.stringify({ error: "Content is required for summarization" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }
      
      const { content } = data;
      
      // Check if content is empty
      if (!content.trim()) {
        return new Response(JSON.stringify({ 
          summary: "The note is empty. There's nothing to summarize." 
        }), {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }
      
      // Use Workers AI for summarization
      const ai = env.AI;
      
      // Prepare input for summarization
      const prompt = `
        Please provide a concise summary of the following note:
        
        ${content.trim()}
        
        Summary:
      `;
  
      // Run the AI model
      const result = await ai.run('@cf/meta/llama-3-8b-instruct', {
        prompt: prompt,
        max_tokens: 300
      });
  
      // Return the summary
      return new Response(JSON.stringify({ 
        summary: result.response.trim() 
      }), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('Error generating summary:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
  }
  
  // Durable Object for real-time collaboration
  export class NotesCollaboration {
    constructor(state, env) {
      this.state = state;
      this.storage = state.storage;
      this.sessions = new Map();
      this.env = env;
      this.note = null;
    }
    
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      
      // Handle WebSocket connections
      if (request.headers.get("Upgrade") === "websocket") {
        return this.handleWebSocket(request);
      }
      
      // Handle internal requests
      if (path === "/init") {
        const data = await request.json();
        this.note = data;
        await this.storage.put("note", data);
        return new Response("Initialized");
      }
      
      if (path === "/update") {
        const data = await request.json();
        
        // Load note if not loaded
        if (!this.note) {
          this.note = await this.storage.get("note");
        }
        
        // Update note data
        if (this.note) {
          this.note = {
            ...this.note,
            title: data.title !== undefined ? data.title : this.note.title,
            content: data.content !== undefined ? data.content : this.note.content,
            updatedAt: new Date().toISOString()
          };
          
          await this.storage.put("note", this.note);
          
          // Broadcast update to connected clients
          this.broadcast({
            type: "update",
            title: this.note.title,
            content: data.content !== undefined ? data.content : undefined,
            updatedAt: this.note.updatedAt
          }, data.clientId);
        }
        
        return new Response("Updated");
      }
      
      if (path === "/delete") {
        // Close all connections
        for (const session of this.sessions.values()) {
          session.send(JSON.stringify({ type: "deleted" }));
          session.close();
        }
        
        // Clear data
        await this.storage.delete("note");
        this.note = null;
        
        return new Response("Deleted");
      }
      
      return new Response("Not found", { status: 404 });
    }
    
    // Handle WebSocket connections
    async handleWebSocket(request) {
      // Accept the WebSocket
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      // Get client ID from URL
      const url = new URL(request.url);
      const clientId = url.searchParams.get("clientId") || `anon_${Math.random().toString(36).substring(2, 9)}`;
      
      // Accept the connection
      server.accept();
      
      // Load note data if not loaded
      if (!this.note) {
        this.note = await this.storage.get("note");
      }
      
      // Create session
      const session = {
        webSocket: server,
        clientId,
        send: (data) => {
          try {
            server.send(JSON.stringify(data));
          } catch (e) {
            // Ignore errors
          }
        },
        close: () => {
          try {
            server.close();
          } catch (e) {
            // Ignore errors
          }
        }
      };
      
      // Store session
      this.sessions.set(clientId, session);
      
      // Send current note data to the client
      if (this.note) {
        session.send({
          type: "init",
          note: this.note,
          clients: Array.from(this.sessions.keys()).filter(id => id !== clientId)
        });
      }
      
      // Notify other clients about the new connection
      this.broadcast({
        type: "join",
        clientId,
        time: new Date().toISOString()
      }, clientId);
      
      // Handle messages from this client
      server.addEventListener("message", async (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === "update") {
            // Update note data
            if (this.note) {
              this.note = {
                ...this.note,
                title: data.title !== undefined ? data.title : this.note.title,
                content: data.content !== undefined ? data.content : this.note.content,
                updatedAt: new Date().toISOString()
              };
              
              await this.storage.put("note", this.note);
              
              // Broadcast to other clients
              this.broadcast({
                type: "update",
                title: data.title,
                content: data.content,
                updatedAt: this.note.updatedAt
              }, clientId);
            }
          } else if (data.type === "cursor") {
            // Broadcast cursor position to other clients
            this.broadcast({
              type: "cursor",
              clientId,
              x: data.x,
              y: data.y
            }, clientId);
          }
        } catch (e) {
          // Ignore errors
        }
      });
      
      // Handle disconnection
      const closeHandler = () => {
        this.sessions.delete(clientId);
        
        // Notify other clients
        this.broadcast({
          type: "leave",
          clientId,
          time: new Date().toISOString()
        });
      };
      
      server.addEventListener("close", closeHandler);
      server.addEventListener("error", closeHandler);
      
      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }
    
    // Broadcast a message to all connected clients except the sender
    broadcast(message, excludeId = null) {
      for (const [clientId, session] of this.sessions.entries()) {
        if (clientId !== excludeId) {
          session.send(message);
        }
      }
    }
  }
  
  // Export default for ES Module format - this is the key change!
  export default {
    async fetch(request, env, ctx) {
      return handleRequest(request, env);
    }
  };