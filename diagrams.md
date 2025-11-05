# Agentic AI Search - Architecture Diagrams

This document contains various architecture diagrams illustrating the evolution from simple RAG to advanced agentic AI search.

---

## 1. Simple RAG Search

A basic RAG (Retrieval-Augmented Generation) system with direct search and response.

```mermaid
flowchart LR
    User([User Query]) --> Search[Cloudflare AI Search<br/>Vector Search]
    Search --> Results[Retrieved Documents]
    Results --> LLM[LLM<br/>Gemini 2.5 Pro]
    LLM --> Response([Summarized Answer])
    
    style User fill:#e1f5ff
    style Response fill:#e1f5ff
    style Search fill:#e1ffe1
    style LLM fill:#ffe1f5
```

**Characteristics:**
- Single search query
- No iterative refinement
- Direct answer generation
- Limited context understanding

---

## 2. Basic Agentic AI Search

Enhanced RAG with an LLM agent that can use search tools with multiple steps.

```mermaid
flowchart LR
    User([User Query]) --> Agent[LLM with Search Tool<br/>Gemini 2.5 Flash<br/>Max Steps: X]
    Agent --> SearchTool[Search Tool Calls]
    SearchTool --> AISearch[Cloudflare AI Search]
    AISearch --> Agent
    Agent --> Synthesize[Summarize Answer<br/>Gemini 2.5 Pro]
    Synthesize --> Response([Final Answer])
    
    style User fill:#e1f5ff
    style Response fill:#e1f5ff
    style Agent fill:#fff4e1
    style AISearch fill:#e1ffe1
    style Synthesize fill:#ffe1f5
```

**Characteristics:**
- LLM with search tool capability
- Multiple tool calls (up to max steps)
- Simple agent-driven search
- Direct answer synthesis

---

## 3. Advanced Agentic AI Search

Sophisticated agentic system with knowledge accumulation and sufficiency evaluation.

```mermaid
flowchart LR
    User([User Query]) --> Search[LLM with Search Tool<br/>Gemini 2.5 Flash<br/>Max 3 searches per iteration]
    Search --> Knowledge[Summarize Knowledge<br/>Extract Key Facts]
    
    Knowledge --> Evaluate[Ask Agent:<br/>Is This Info Enough?<br/>Gemini 2.5 Flash]
    Evaluate --> Decision{Knowledge<br/>Sufficient?}
    
    Decision -->|No & < Max 5 iterations| Search
    Decision -->|Yes| Synthesize[Summarize Answer<br/>Gemini 2.5 Pro]
    
    Synthesize --> Response([Final Answer])
    
    style User fill:#e1f5ff
    style Response fill:#e1f5ff
    style Search fill:#fff4e1
    style Evaluate fill:#fff4e1
    style Synthesize fill:#ffe1f5
```

**Characteristics:**
- Multi-iteration knowledge gathering (up to 5 loops)
- Multiple searches per iteration (up to 3)
- Knowledge accumulation across iterations
- Structured sufficiency evaluation
- Intelligent stopping conditions
- Comprehensive final synthesis

---

## 4. Query Rewrite Feature

Contextual query consolidation for follow-up questions in conversations.

```mermaid
flowchart LR
    Start([User Message]) --> CheckHistory{Has Previous<br/>Messages?}
    
    CheckHistory -->|No| Execute[Continue Agentic<br/>Execution]
    CheckHistory -->|Yes| Rewrite[Build Rewrite Prompt<br/>with Context<br/>Gemini 2.5 Flash]
    
    Rewrite --> Execute
    
    style Start fill:#e1f5ff
    style Rewrite fill:#e1e8ff
    style Execute fill:#d4edda
```

**Example:**

```
Previous Queries:
1. "Can a car run without an engine?"
2. "What about without a transmission?"

Current Query:
3. "And without a tire?"

Rewritten Query:
→ "Can a car run without an engine, transmission, or tire?"
```

**Benefits:**
- Maintains conversation context
- Self-contained search queries
- Better search relevance for follow-ups

---

## 5. System Architecture Overview

Complete system architecture showing all components.

```mermaid
flowchart TB
    subgraph Frontend ["Frontend (Vanilla JS + Tailwind)"]
        UI[Chat Interface]
        WS[WebSocket Client]
        LocalStorage[Local Storage<br/>Room ID & RAG Selection]
    end
    
    subgraph CloudflareWorkers ["Cloudflare Workers (Edge)"]
        Router[Request Router]
        AgentRouter[Agent Router]
        API[REST API Endpoints<br/>/api/rags, /documents]
    end
    
    subgraph DurableObjects ["Durable Objects"]
        SearchAgent[SearchAgent<br/>extends AIChatAgent]
        State[Persistent State<br/>Messages & Session]
    end
    
    subgraph AIServices ["AI Services"]
        Gemini[Google Gemini<br/>2.5 Pro & Flash]
        AISearch[Cloudflare AI Search<br/>Vector Database]
    end
    
    subgraph Storage ["Cloudflare Storage"]
        R2[R2 Bucket<br/>Document Storage]
        DO_Storage[DO Storage<br/>Session Persistence]
    end
    
    UI <--> WS
    WS <--> AgentRouter
    UI --> LocalStorage
    
    Router --> API
    Router --> AgentRouter
    
    AgentRouter <--> SearchAgent
    SearchAgent <--> State
    
    SearchAgent --> Gemini
    SearchAgent --> AISearch
    
    SearchAgent <--> DO_Storage
    API <--> R2
    AISearch -.indexes.-> R2
    
    style Frontend fill:#e3f2fd
    style CloudflareWorkers fill:#fff9c4
    style DurableObjects fill:#f3e5f5
    style AIServices fill:#e8f5e9
    style Storage fill:#fce4ec
```

---

## 6. Comparison: Simple vs Basic vs Advanced

| Feature | Simple RAG | Basic Agentic | Advanced Agentic |
|---------|-----------|---------------|------------------|
| **Search Iterations** | 1 | Multiple (up to max) | Multiple (up to 5) with evaluation |
| **Query Rewriting** | ❌ | ❌ | ✅ Contextual |
| **Knowledge Accumulation** | ❌ | ❌ | ✅ Across iterations |
| **Sufficiency Evaluation** | ❌ | ❌ | ✅ Structured output |
| **Tool Use** | ❌ | ✅ Basic | ✅ Advanced with limits |
| **Session Persistence** | ❌ | ❌ | ✅ Durable Objects |
| **Streaming Response** | ✅ | ✅ | ✅ |
| **Multi-RAG Support** | ❌ | ❌ | ✅ |
| **Document Tracking** | ❌ | ❌ | ✅ With metadata |

---

## 7. Agentic Loop Detailed Flow

Detailed breakdown of the agentic loop iteration process.

```mermaid
sequenceDiagram
    participant User
    participant Agent as SearchAgent<br/>(Durable Object)
    participant Flash as Gemini 2.5 Flash
    participant AISearch as Cloudflare AI Search
    participant Pro as Gemini 2.5 Pro
    
    User->>Agent: Send Query via WebSocket
    Agent->>Agent: Load Persisted Messages
    
    alt Has Previous User Messages
        Agent->>Flash: Request Query Rewrite
        Flash-->>Agent: Rewritten Query
        Agent->>User: Notify Query Rewrite
    end
    
    loop Agentic Loop (max 5 iterations)
        Agent->>Flash: Knowledge Generation<br/>with searchDocuments tool
        
        loop Tool Calls (max 3 per iteration)
            Flash->>Agent: Call searchDocuments(query)
            Agent->>AISearch: Perform Vector Search
            AISearch-->>Agent: Return Documents
            Agent-->>Flash: Return Search Results
        end
        
        Flash-->>Agent: Extracted Knowledge (3-5 facts)
        Agent->>Agent: Accumulate Knowledge
        
        Agent->>Flash: Evaluate Sufficiency<br/>Structured Output
        Flash-->>Agent: {isKnowledgeEnough, nextSearchQuery}
        
        alt Knowledge Sufficient
            Agent->>Agent: Exit Loop
        else Need More Info & < Max Iterations
            Agent->>Agent: Continue with Next Query
        end
    end
    
    Agent->>Pro: Synthesize Final Answer<br/>with Accumulated Knowledge
    Pro-->>Agent: Stream Response
    Agent->>User: Stream Text Deltas
    Agent->>Agent: Persist Messages
    Agent->>User: Send File Metadata
    Agent->>User: Complete
```

---

## Conclusion

This architecture represents a significant evolution from simple RAG systems, incorporating:

1. **Agentic Reasoning**: LLM-driven decision making for search strategies
2. **Knowledge Accumulation**: Building comprehensive context across multiple searches
3. **Intelligent Evaluation**: Structured assessment of information sufficiency
4. **Contextual Awareness**: Query rewriting based on conversation history
5. **Production-Ready**: Session persistence, streaming, and multi-tenancy support

The system runs entirely on Cloudflare's edge infrastructure, providing low-latency, globally distributed AI-powered document search.
