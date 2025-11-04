import { AIChatAgent } from 'agents/ai-chat-agent';
import { routeAgentRequest } from 'agents';
import { google } from '@ai-sdk/google';
import { streamText, tool, stepCountIs } from 'ai';
import { z } from 'zod';

interface Env {
    AI: any;
    ASSETS: any;
    GOOGLE_GENERATIVE_AI_API_KEY: string;
    SearchAgent: DurableObjectNamespace;
}

interface AgentState {
    totalSearches: number;
    lastSearchTime: number;
}

// Search Agent using AIChatAgent
export class SearchAgent extends AIChatAgent<Env, AgentState> {
    initialState: AgentState = {
        totalSearches: 0,
        lastSearchTime: 0,
    };

    async onMessage(connection: any, message: string | ArrayBuffer) {
        console.log('[Agent] Received message:', typeof message === 'string' ? message : 'binary');

        try {
            if (typeof message === 'string') {
                const data = JSON.parse(message);

                // Add messages to the agent's history
                if (data.messages && Array.isArray(data.messages)) {
                    this.messages = [...this.messages, ...data.messages];
                    console.log('[Agent] Messages added, total:', this.messages.length);

                    // Trigger onChatMessage to generate response and stream it
                    await this.processAndStreamResponse(connection);
                }
            }
        } catch (error: any) {
            console.error('[Agent] Error handling message:', error);
            connection.send(JSON.stringify({ type: 'error', error: error.message }));
        }
    }

    async processAndStreamResponse(connection: any) {
        console.log('[Agent] Processing chat message:', this.messages.length, 'messages');

        await this.streamWithMultiStepTools(connection);

        // Send final finish message
        connection.send(JSON.stringify({ type: 'finish' }));
    }

    async streamWithMultiStepTools(connection: any) {
        // Define the search tool
        const searchGovernmentReports = tool({
            description: 'Search through a database of 1,000 government PDF reports from .gov domains. Use this tool to find relevant information about government policies, regulations, reports, and documents.',
            inputSchema: z.object({
                query: z.string().describe('The search query to find relevant government reports'),
            }),
            execute: async ({ query }) => {
                console.log(`[Tool] Searching for: "${query}"`);

                // Notify the client that a search is starting
                connection.send(JSON.stringify({
                    type: 'search-start',
                    query: query
                }));

                // Update state
                this.setState({
                    totalSearches: this.state.totalSearches + 1,
                    lastSearchTime: Date.now(),
                });

                try {
                    const searchResults = await this.env.AI.autorag('public-reports').search({
                        query: query,
                        rewrite_query: false,
                        max_num_results: 10,
                        ranking_options: {
                            score_threshold: 0.3
                        },
                        reranking: {
                            enabled: false,
                            model: '@cf/baai/bge-reranker-base'
                        }
                    });

                    if (!searchResults.data || searchResults.data.length === 0) {
                        return {
                            success: true,
                            found: false,
                            message: 'No relevant documents found for this query.',
                            count: 0,
                            results: []
                        };
                    }

                    const formattedResults = searchResults.data.map((result: any, index: number) => ({
                        rank: index + 1,
                        filename: result.filename || 'Unknown',
                        score: Math.round(result.score * 100) / 100,
                        content: result.content?.map((c: any) => c.text).join(' ').substring(0, 400),
                        file_id: result.file_id
                    }));

                    const toolResult = {
                        success: true,
                        found: true,
                        count: formattedResults.length,
                        search_query: searchResults.search_query || query,
                        results: formattedResults
                    };
                    console.log('[Tool] Returning results:', toolResult.count, 'documents found');
                    return toolResult;
                } catch (error: any) {
                    console.error('[Tool] Search error:', error);
                    const errorResult = {
                        success: false,
                        error: 'Failed to search the database',
                        message: error.message
                    };
                    console.log('[Tool] Returning error result');
                    return errorResult;
                }
            },
        });

        // Stream response with multi-step tool calling
        const result = streamText({
            model: google('gemini-2.5-pro'),
            system: `You are a helpful AI assistant with access to a database of 1,000 government PDF reports from .gov domains.

IMPORTANT: You MUST use the searchGovernmentReports tool to look up information. Do not make assumptions or provide information without searching first.

Your process:
1. When a user asks a question, ALWAYS call searchGovernmentReports with relevant search terms
2. You can call the tool multiple times with different queries to gather comprehensive information
3. After receiving search results, analyze them and provide a clear, informative answer
4. Cite specific documents by mentioning their filenames
5. If searches return no results after trying different terms, tell the user the information is not available

Be thorough, accurate, and always search before responding.`,
            messages: this.messages as any,
            tools: {
                searchGovernmentReports,
            },
            stopWhen: stepCountIs(5), // Use built-in multi-step with max 5 steps
            onStepFinish: ({ text, toolCalls, toolResults, finishReason, usage }) => {
                console.log('[Agent] Step finished - Reason:', finishReason, 'Tools called:', toolCalls.length, 'Usage:', usage);
            },
            onFinish: ({ text, finishReason, usage, response, steps, totalUsage }) => {
                console.log('[Agent] All steps complete - Reason:', finishReason);
                console.log('[Agent] Total steps:', steps.length);
                console.log('[Agent] Total usage:', totalUsage);
            },
            onError: ({ error }) => {
                console.error('[Agent] Stream error occurred:', error);
            },
        });

        // Stream all chunks to WebSocket with proper handling of all chunk types
        for await (const part of result.fullStream) {
            switch (part.type) {
                case 'start': {
                    console.log('[Agent] Stream started');
                    break;
                }
                case 'start-step': {
                    console.log('[Agent] Step started');
                    break;
                }
                case 'text-start': {
                    console.log('[Agent] Text generation started');
                    break;
                }
                case 'text-delta': {
                    connection.send(JSON.stringify({
                        type: 'text-delta',
                        textDelta: part.text
                    }));
                    break;
                }
                case 'text-end': {
                    console.log('[Agent] Text generation ended');
                    break;
                }
                case 'reasoning-start': {
                    console.log('[Agent] Reasoning started');
                    break;
                }
                case 'reasoning-delta': {
                    console.log('[Agent] Reasoning delta');
                    break;
                }
                case 'reasoning-end': {
                    console.log('[Agent] Reasoning ended');
                    break;
                }
                case 'source': {
                    console.log('[Agent] Source:', part);
                    break;
                }
                case 'file': {
                    console.log('[Agent] File:', part);
                    break;
                }
                case 'tool-call': {
                    console.log('[Agent] Tool call:', part.toolName, part.input);
                    connection.send(JSON.stringify({
                        type: 'tool-call',
                        toolName: part.toolName,
                        args: part.input
                    }));
                    break;
                }
                case 'tool-input-start': {
                    console.log('[Agent] Tool input start:', part.toolName);
                    break;
                }
                case 'tool-input-delta': {
                    console.log('[Agent] Tool input delta');
                    break;
                }
                case 'tool-input-end': {
                    console.log('[Agent] Tool input end');
                    break;
                }
                case 'tool-result': {
                    console.log('[Agent] Tool result:', part.toolName);
                    connection.send(JSON.stringify({
                        type: 'tool-result',
                        toolName: part.toolName,
                        result: part.output
                    }));
                    break;
                }
                case 'tool-error': {
                    console.error('[Agent] Tool error:', part.toolName, part.error);
                    connection.send(JSON.stringify({
                        type: 'tool-error',
                        toolName: part.toolName,
                        error: part.error
                    }));
                    break;
                }
                case 'finish-step': {
                    console.log('[Agent] Step finished:', part.finishReason, 'Usage:', part.usage);
                    break;
                }
                case 'finish': {
                    console.log('[Agent] Stream finished:', part.finishReason);
                    break;
                }
                case 'error': {
                    console.error('[Agent] Stream error:', part.error);
                    connection.send(JSON.stringify({
                        type: 'error',
                        error: part.error
                    }));
                    break;
                }
                case 'raw': {
                    console.log('[Agent] Raw chunk');
                    break;
                }
                default: {
                    console.log('[Agent] Unhandled chunk type:', (part as any).type);
                }
            }
        }

        // Use response.messages to update conversation history automatically
        const response = await result.response;
        this.messages.push(...response.messages as any);
        console.log('[Agent] Multi-step complete. Total messages:', this.messages.length);
    }

    async onChatMessage(onFinish) {
        // This method is not used in our WebSocket implementation
        // but is required by AIChatAgent
        return undefined;
    }

    onStateUpdate(state: AgentState) {
        console.log('[Agent] State updated:', state);
    }
}

// Worker fetch handler
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // Route to agents under /agents/* path using the built-in router
        if (url.pathname.startsWith('/agents/')) {
            return await routeAgentRequest(request, env) ||
                Response.json({ error: 'Agent not found' }, { status: 404 });
        }

        // Default: serve static assets
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        // Fallback if ASSETS not available
        return new Response('Not Found', { status: 404 });
    }
};
