# Spoilerie

Chrome extension that detects spoilers in YouTube comments based on your current watch position.

## How it works

1. **Extension** reads your current playback position and scrapes visible comments
2. **Backend** fetches the video transcript and embeds it into timestamp-labeled chunks
3. **ML model** matches each comment to a transcript segment to estimate when it references
4. **Extension** hides/blurs comments that reference content you haven't watched yet

## Stack

| Layer | Tech |
|-------|------|
| Chrome Extension | TypeScript, React, Manifest V3 |
| Backend | Python, FastAPI |
| ML | sentence-transformers, PyTorch |
| DB/Cache | Supabase (PostgreSQL) + Redis |
| Hosting | Railway (API) + Hugging Face (model) |

## Project structure

```
spoilerie/
├── extension/      # Chrome extension
├── backend/        # FastAPI backend + ML inference
└── training/       # Model training pipeline
```

## Development

### Extension
```bash
cd extension
npm install
npm run dev     # watch mode
npm run build   # production build
```

### Backend
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn api.main:app --reload
```

### Training
```bash
cd training
pip install -r requirements.txt
python scripts/collect_data.py
python scripts/train.py
```
