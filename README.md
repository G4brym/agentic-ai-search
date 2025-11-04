# Agentic RAG/AI Search - Government Reports

An AI-powered search assistant that helps you search through 1,000 government PDF reports from .gov domains using Cloudflare Workers, AutoRAG (AI Search), and Google Gemini 2.0 Flash.

## Features

- 🤖 **AI Agent with Function Calling** - Uses Google Gemini 2.0 Flash with Vercel AI SDK
- 🔍 **Semantic Search** - Powered by Cloudflare AutoRAG/AI Search
- 💬 **Modern Chat Interface** - Built with vanilla HTML, CSS (Tailwind), and jQuery
- ⚡ **Edge Deployment** - Runs on Cloudflare Workers
- 📚 **1,000 Government Reports** - From Library of Congress web archives

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Google API Key

Get your Google API key from [Google AI Studio](https://aistudio.google.com/apikey)

**For local development:**
Create a `.dev.vars` file in the root directory:

```bash
cp .dev.vars.example .dev.vars
```

Then edit `.dev.vars` and add your API key:

```
GOOGLE_GENERATIVE_AI_API_KEY=your_actual_api_key_here
```

**For production deployment:**
Set the secret using Wrangler:

```bash
npx wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
```

Or set it in the Cloudflare dashboard under Workers > Your Worker > Settings > Variables

### 3. Configure AutoRAG Instance

The application uses the `public-reports` AutoRAG instance. Make sure:
- You have an AutoRAG instance named `public-reports` in your Cloudflare account
- It contains the 1,000 government PDF reports
- The AI binding is configured in `wrangler.jsonc` (already done)

## Development

Run locally:

```bash
npm run dev
```

The chat interface will be available at `http://localhost:8787`

## Deployment

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

## How It Works

1. **User Query** - User asks a question through the chat interface
2. **AI Agent** - Google Gemini 2.0 Flash receives the query
3. **Function Calling** - Agent decides to call the `search_government_reports` tool
4. **AutoRAG Search** - Searches the vector database with semantic search and reranking
5. **Multi-Step Reasoning** - Agent can make multiple searches to gather comprehensive information
6. **Response** - Agent synthesizes findings and returns an answer with source citations

## Tech Stack

- **Frontend**: Vanilla HTML, Tailwind CSS, jQuery
- **Backend**: Cloudflare Workers (TypeScript)
- **AI Model**: Google Gemini 2.0 Flash Experimental
- **AI SDK**: Vercel AI SDK
- **Vector Search**: Cloudflare AutoRAG/AI Search
- **Deployment**: Cloudflare Workers

## API Endpoints

### POST `/api/chat`

Main chat endpoint for AI agent interactions.

**Request:**
```json
{
  "message": "What information is available about healthcare policies?"
}
```

**Response:**
```json
{
  "message": "Based on the search results...",
  "sources": [
    {
      "file_id": "doc123",
      "filename": "healthcare-policy-2020.pdf",
      "score": 0.85,
      "content": [...]
    }
  ],
  "steps": 2
}
```

## Architecture

```
User Request
    ↓
Chat Interface (HTML/CSS/JS)
    ↓
POST /api/chat
    ↓
Google Gemini 2.0 Flash (via Vercel AI SDK)
    ↓
Function Call: search_government_reports
    ↓
Cloudflare AutoRAG (public-reports instance)
    ↓
Vector Search + Reranking
    ↓
AI Agent Synthesis
    ↓
Response with Sources
```

## Environment Variables

- `GOOGLE_GENERATIVE_AI_API_KEY` - Your Google AI API key (required)
- `AI` - Cloudflare AI binding (automatically configured)

## License

MIT
