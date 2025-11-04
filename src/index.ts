import { AIChatAgent } from 'agents/ai-chat-agent';
import { routeAgentRequest } from 'agents';
import { google } from '@ai-sdk/google';
import {streamText, generateText, generateObject, tool, stepCountIs} from 'ai';
import { z } from 'zod';

interface Env {
    AI: any;
    ASSETS: any;
    BUCKET: R2Bucket;
    GOOGLE_GENERATIVE_AI_API_KEY: string;
    SearchAgent: DurableObjectNamespace;
}

interface AgentState {
    totalSearches: number;
    lastSearchTime: number;
    selectedRag: string;
}

// Search Agent using AIChatAgent
export class SearchAgent extends AIChatAgent<Env, AgentState> {
    initialState: AgentState = {
        totalSearches: 0,
        lastSearchTime: 0,
        selectedRag: '',
    };

    // Override constructor to load persisted messages
    constructor(state: any, env: Env) {
        super(state, env);
        // Messages will be loaded in onConnect
    }

    // Load messages from storage when client connects
    async onConnect(connection: any) {
        console.log('[Agent] Client connected, loading persisted messages...');

        // Load messages from Durable Object storage
        const storedMessages = await this.ctx.storage.get('messages');
        if (storedMessages) {
            this.messages = storedMessages as any[];
            console.log('[Agent] Loaded', this.messages.length, 'persisted messages');
            
            // Send message history to the client
            if (this.messages.length > 0) {
                connection.send(JSON.stringify({
                    type: 'message-history',
                    messages: this.messages
                }));
                console.log('[Agent] Sent message history to client');
            }
        } else {
            console.log('[Agent] No persisted messages found, starting fresh');
        }
    }

    // Save messages to storage
    async persistMessages() {
        await this.ctx.storage.put('messages', this.messages);
        console.log('[Agent] Persisted', this.messages.length, 'messages');
    }

    async onMessage(connection: any, message: string | ArrayBuffer) {
        console.log('[Agent] Received message:', typeof message === 'string' ? message : 'binary');

        try {
            if (typeof message === 'string') {
                const data = JSON.parse(message);

                // Update selected RAG if provided
                if (data.selectedRag && typeof data.selectedRag === 'string') {
                    this.setState({
                        ...this.state,
                        selectedRag: data.selectedRag
                    });
                    console.log('[Agent] RAG updated to:', data.selectedRag);
                }

                // Add messages to the agent's history
                if (data.messages && Array.isArray(data.messages)) {
                    // Ensure we have the latest persisted messages before adding new ones
                    const storedMessages = await this.ctx.storage.get('messages');
                    if (storedMessages && Array.isArray(storedMessages)) {
                        this.messages = storedMessages as any[];
                        console.log('[Agent] Reloaded', this.messages.length, 'persisted messages before processing');
                    }

                    this.messages = [...this.messages, ...data.messages];
                    console.log('[Agent] Messages added, total:', this.messages.length);

                    // Persist messages before processing
                    await this.persistMessages();

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

        const usedFiles = await this.streamWithMultiStepTools(connection);

        // Persist messages after response generation
        await this.persistMessages();

        // Send file metadata for download links
        if (usedFiles.length > 0) {
            connection.send(JSON.stringify({
                type: 'files',
                files: usedFiles
            }));
        }

        // Send final finish message
        connection.send(JSON.stringify({ type: 'finish' }));
    }

    async streamWithMultiStepTools(connection: any): Promise<Array<{filename: string, file_id: string}>> {
        const allFiles = new Map<string, {filename: string, file_id: string}>();
        const accumulatedKnowledge: string[] = [];
        const maxIterations = 5;
        let iteration = 0;

        // Get the user's original query from the last message
        const userQuery = this.messages[this.messages.length - 1].content as string;
        let currentSearchQuery = userQuery;

        // Query rewriting: If there are previous user messages, consolidate them into a single query
        const previousUserMessages = this.messages
            .slice(0, -1) // Exclude the current message
            .filter((msg: any) => msg.role === 'user')
            .map((msg: any) => msg.content as string);

        if (previousUserMessages.length > 0) {
            console.log('[Agent] Found', previousUserMessages.length, 'previous user messages, rewriting query...');
            
            try {
                const rewriteResult = await generateText({
                    model: google('gemini-2.5-flash'),
                    prompt: `You are a query rewriting assistant. Your task is to combine multiple related user queries into a single, comprehensive query that captures the user's current intent.

Previous user queries (in chronological order):
${previousUserMessages.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Current user query:
${userQuery}

Task: Rewrite this into a single, clear, and comprehensive query that represents what the user is actually asking for now, considering the conversation context. The rewritten query should be self-contained and capture the full intent.

Important: Focus on the user's CURRENT intent. If the current query builds upon or modifies previous queries, make sure the rewritten query reflects the current state of the question, not the history.

Provide ONLY the rewritten query, nothing else.`,
                });

                currentSearchQuery = rewriteResult.text.trim();
                console.log('[Agent] Query rewritten from:', userQuery);
                console.log('[Agent] To:', currentSearchQuery);

                // Notify the client about the query rewrite
                connection.send(JSON.stringify({
                    type: 'query-rewrite',
                    original: userQuery,
                    rewritten: currentSearchQuery
                }));
            } catch (error) {
                console.error('[Agent] Error rewriting query, using original:', error);
                // Fall back to original query on error
            }
        }

        console.log('[Agent] Starting agentic loop with search query:', currentSearchQuery);

        // Define search function (not a tool anymore, called directly)
        const performSearch = async (query: string) => {
            console.log(`[Agent] Searching for: "${query}"`);

            // Check if RAG is selected
            if (!this.state.selectedRag) {
                const errorMsg = 'No RAG instance selected. Please select a RAG from the dropdown.';
                console.error('[Agent]', errorMsg);
                throw new Error(errorMsg);
            }

            // Notify the client that a search is starting
            connection.send(JSON.stringify({
                type: 'search-start',
                query: query
            }));

            // Update state
            this.setState({
                ...this.state,
                totalSearches: this.state.totalSearches + 1,
                lastSearchTime: Date.now(),
            });

            try {
                const searchResults = await this.env.AI.autorag(this.state.selectedRag).search({
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

                // Collect file metadata
                for (const result of formattedResults) {
                    if (result.filename) {
                        allFiles.set(result.filename, {
                            filename: result.filename,
                            file_id: result.file_id
                        });
                    }
                }

                const toolResult = {
                    success: true,
                    found: true,
                    count: formattedResults.length,
                    search_query: searchResults.search_query || query,
                    results: formattedResults
                };
                console.log('[Agent] Returning results:', toolResult.count, 'documents found');
                return toolResult;
            } catch (error: any) {
                console.error('[Agent] Search error:', error);
                return {
                    success: false,
                    error: 'Failed to search the database',
                    message: error.message,
                    results: []
                };
            }
        };

        // Define search as a tool for the LLM
        const searchTool = tool({
            description: 'Search through a document database. Use this tool to find relevant information from the indexed documents.',
            inputSchema: z.object({
                query: z.string().describe('The search query to find relevant documents'),
            }),
            execute: async ({ query }) => {
                return await performSearch(query);
            },
        });

        // Agentic loop
        while (true) {
            iteration++;
            console.log(`[Agent] Iteration ${iteration}/${maxIterations}`);

            // Step 1 & 2: Let the LLM search and generate knowledge entries using tools
            console.log('[Agent] Generating knowledge from search results...');
            const knowledgeGeneration = await generateText({
                model: google('gemini-2.5-flash'),
                tools: {
                    searchDocuments: searchTool,
                },
                stopWhen: stepCountIs(5),
                prompt: `You are gathering information to answer a user's query.

User Original Query: ${userQuery}
${userQuery !== currentSearchQuery ? `Rewritten Search Query: ${currentSearchQuery}` : ''}

${iteration === 1 ? `Current Search Query: ${currentSearchQuery}` : `Next Search Query: ${currentSearchQuery}`}

${accumulatedKnowledge.length > 0 ? `Previously Accumulated Knowledge:
${accumulatedKnowledge.join('\n\n')}

` : ''}Task:
1. Use the searchDocuments tool to search documents with any query related to the user question
2. Analyze the search results
3. Continue using the searchDocuments tool with different queries to get more knowledge (max 3 times)
3. Extract 3-5 key knowledge entries that are relevant to answering the user's query
4. Format each knowledge entry as a clear, concise bullet point with document filename for reference

Provide your knowledge extraction.`,
            });

            const newKnowledge = knowledgeGeneration.text;
            if (newKnowledge.trim()) {
                accumulatedKnowledge.push(newKnowledge);
                console.log('[Agent] Knowledge extracted:', newKnowledge.substring(0, 200) + '...');
            } else {
                console.log('[Agent] No knowledge extracted, breaking loop');
                break;
            }

            // Step 3: Evaluate if we have enough knowledge (structured output)
            console.log('[Agent] Evaluating knowledge sufficiency...');
            const decision = await generateObject({
                model: google('gemini-2.5-flash'),
                schema: z.object({
                    isKnowledgeEnough: z.boolean().describe('Whether the accumulated knowledge is sufficient to fully answer the user query'),
                    nextSearchQuery: z.string().optional().describe('If more information is needed, provide the next search query to explore'),
                }),
                prompt: `You are evaluating whether accumulated knowledge is sufficient to answer a user query.

User Query: ${userQuery}

Accumulated Knowledge (${iteration} search${iteration > 1 ? 'es' : ''}):
${accumulatedKnowledge.join('\n\n')}

Task: Determine if this knowledge is sufficient to provide a comprehensive answer. If not, suggest what additional information to search for.

Consider:
- Is the query fully addressed?
- Are there gaps or missing details?
- Would additional context help?

Provide your evaluation.`,
            });

            console.log('[Agent] Decision:', decision.object);

            // Step 4: Check stopping conditions
            if (decision.object.isKnowledgeEnough || iteration >= maxIterations) {
                console.log('[Agent] Loop complete. Sufficient knowledge:', decision.object.isKnowledgeEnough, 'Max iterations:', iteration >= maxIterations);
                break;
            }

            // Continue with next search query
            if (decision.object.nextSearchQuery) {
                currentSearchQuery = decision.object.nextSearchQuery;
                console.log('[Agent] Continuing with next query:', currentSearchQuery);
            } else {
                console.log('[Agent] No next query provided, breaking loop');
                break;
            }
        }

        // Final step: Stream comprehensive answer using all accumulated knowledge
        console.log('[Agent] Streaming final answer with accumulated knowledge...');
        const finalResult = streamText({
            model: google('gemini-2.5-pro'),
            prompt: `You are answering a user's question using accumulated knowledge from documents.

User Query: ${userQuery}

Accumulated Knowledge from ${iteration} search${iteration > 1 ? 'es' : ''}:
${accumulatedKnowledge.join('\n\n')}

Task: Provide a comprehensive, well-structured answer to the user's query based on the accumulated knowledge.

IMPORTANT: Do NOT reference, cite, or mention any document filenames in your response. Just provide the information directly without attribution to specific files. Download links will be automatically provided to the user separately.

Be clear, accurate, and thorough in your response.`,
        });

        // Collect the complete response text
        let completeResponse = '';

        // Stream the final response to the client
        for await (const part of finalResult.fullStream) {
            switch (part.type) {
                case 'text-delta': {
                    completeResponse += part.text;
                    connection.send(JSON.stringify({
                        type: 'text-delta',
                        textDelta: part.text
                    }));
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
            }
        }

        // Add assistant's response to message history
        if (completeResponse.trim()) {
            this.messages.push({
                role: 'assistant',
                content: completeResponse
            } as any);
            console.log('[Agent] Added assistant response to history');
        }

        console.log('[Agent] Agentic loop complete. Total files:', allFiles.size);
        return Array.from(allFiles.values());
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

        // List available RAG instances endpoint
        if (url.pathname === '/api/rags' && request.method === 'GET') {
            try {
                const rags = await env.AI.autorag().list();
                return Response.json({ success: true, rags });
            } catch (error: any) {
                console.error('[Worker] Error listing RAGs:', error);
                return Response.json({ success: false, error: error.message }, { status: 500 });
            }
        }

        // Route to agents under /agents/* path using the built-in router
        if (url.pathname.startsWith('/agents/')) {
            return await routeAgentRequest(request, env) ||
                Response.json({ error: 'Agent not found' }, { status: 404 });
        }

        // Document download endpoint
        if (url.pathname.startsWith('/documents/')) {
            // url.pathname is already decoded by URL constructor
            const filePath = url.pathname.replace('/documents/', '');
            if (!filePath) {
                return Response.json({ error: 'File path required' }, { status: 400 });
            }

            // Decode the filePath to handle encoded slashes
            const decodedPath = decodeURIComponent(filePath);

            // Extract just the filename from the full path for download
            const filename = decodedPath.split('/').pop() || decodedPath;

            console.log('[Worker] Fetching document from R2:', filename);

            try {
                // Get the object from R2 using the filename (not the full path)
                const object = await env.BUCKET.get(decodedPath);

                if (!object) {
                    console.error('[Worker] Document not found in R2:', decodedPath);
                    return Response.json({ error: 'File not found' }, { status: 404 });
                }

                // Return the file with appropriate headers
                const headers = new Headers();
                headers.set('Content-Type', object.httpMetadata?.contentType || 'application/pdf');
                headers.set('Content-Disposition', `attachment; filename="${filename}"`);
                headers.set('Cache-Control', 'public, max-age=31536000');

                return new Response(object.body, { headers });
            } catch (error: any) {
                console.error('[Worker] Error fetching document:', error);
                return Response.json({ error: 'Failed to fetch document' }, { status: 500 });
            }
        }

        // Default: serve static assets
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        // Fallback if ASSETS not available
        return new Response('Not Found', { status: 404 });
    }
};
