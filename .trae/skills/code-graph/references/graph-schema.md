# Understand-Anything Graph Structure Reference

> Source: https://github.com/Lum1104/Understand-Anything  |  v2.9.4

## Knowledge Graph JSON Schema

```json
{
  "project": {
    "name": "string",
    "description": "string", 
    "languages": ["string"],
    "frameworks": ["string"],
    "analyzedAt": "ISO 8601",
    "gitCommitHash": "sha1"
  },
  "nodes": [{
    "id": "type:path" | "type:path:name",
    "type": "file|function|class|module|concept|config|document|service|table|endpoint|pipeline|schema|resource|domain|flow|step",
    "name": "Human-readable name",
    "filePath": "relative/path/to/file",
    "summary": "1-2 sentence description",
    "tags": ["tag1", "tag2"],
    "complexity": "low|medium|high",
    "languageNotes": "optional string"
  }],
  "edges": [{
    "source": "node-id",
    "target": "node-id",
    "type": "imports|contains|calls|depends_on|configures|documents|deploys|triggers|contains_flow|flow_step|related|cites",
    "direction": "forward|bidirectional",
    "weight": 1-10
  }],
  "layers": [{
    "id": "layer-id",
    "name": "string",
    "description": "string",
    "nodeIds": ["node-id"]
  }],
  "tour": [{
    "order": 1,
    "title": "string",
    "description": "string",
    "nodeIds": ["node-id"]
  }]
}
```

## How to Read Efficiently

1. **Don't dump entire graph** — use Grep to search
2. **Search by keyword**: `grep -i "keyword" .ua/knowledge-graph.json`
3. **Find connections**: Grep node IDs in edges section
4. **Layer context**: Grep `"layers"` for architecture
5. **Tour**: Grep `"tour"` for guided walkthrough
