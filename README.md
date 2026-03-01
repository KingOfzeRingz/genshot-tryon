# GenShot TryOn

End-to-end virtual try-on system that bridges physical body measurements captured via iPhone AR/LiDAR with ecommerce garment data scraped via a Chrome extension to produce photorealistic multi-angle try-on images with fit scoring.

Built in 24 hours at the UCL AI Festival hackathon.

---

## Architecture

Three components, one backend:

```
┌──────────────┐       ┌──────────────────┐       ┌────────────────┐
│  iOS App     │       │  FastAPI Backend  │       │  Chrome Ext.   │
│  SwiftUI +   │◄─────►│  Cloud Run (GCP)  │◄─────►│  Manifest V3   │
│  ARKit       │       │                  │       │                │
└──────────────┘       └────────┬─────────┘       └────────────────┘
                                │
                 ┌──────────────┼──────────────┐
                 │              │              │
            Firestore     Cloud Storage   Vertex AI / Gemini
            (users,       (images)        (image generation,
             items,                        size chart LLM)
             generations)
```

| Component | Tech | Location |
|-----------|------|----------|
| iOS app | SwiftUI, ARKit, Vision, MediaPipe, Firebase Auth | `TryOn/` |
| Backend | FastAPI, Firestore, GCS, Vertex AI, Gemini | `backend/` |
| Extension | Manifest V3, content scripts, QR generation | `extension/` |

---

## Project Structure

```
genshot-tryon/
├── README.md
├── IMPLEMENTATION_PLAN.md
├── deploy.sh                        # GCP setup & deploy script
│
├── backend/
│   ├── Dockerfile                   # Python 3.11-slim, uvicorn, 2 workers
│   ├── requirements.txt
│   └── app/
│       ├── main.py                  # FastAPI app factory, Firebase init, CORS
│       ├── config.py                # Pydantic settings from env vars
│       ├── auth/
│       │   ├── firebase_auth.py     # Firebase token verification
│       │   └── dependencies.py      # FastAPI Depends() helpers
│       ├── models/
│       │   ├── body.py              # BodyVector, BodyScanRequest/Response
│       │   ├── generation.py        # GenerationRequest, FitScore, GenerationResult
│       │   ├── item.py              # Item, ImportSession, SizeOption
│       │   └── user.py              # UserProfile
│       ├── routers/
│       │   ├── body_scan.py         # POST /v1/body-scan
│       │   ├── generations.py       # POST + GET /v1/generations
│       │   ├── import_sessions.py   # POST /v1/import-sessions
│       │   ├── items.py             # GET/POST /v1/items
│       │   └── users.py             # GET/PUT /v1/users/me
│       ├── services/
│       │   ├── image_generation.py  # Two-stage Gemini try-on pipeline
│       │   ├── core_image.py        # Core image generation (REVE API)
│       │   ├── body_measurement.py  # MediaPipe pose + depth processing
│       │   ├── fit_engine.py        # Weighted fit scoring per garment type
│       │   ├── size_chart_parser.py # Deterministic Zara/H&M DOM parsers
│       │   ├── size_chart_llm.py    # Gemini structured-output fallback
│       │   ├── firestore.py         # Firestore CRUD operations
│       │   └── storage.py           # GCS upload helpers
│       ├── workers/
│       │   └── generation_worker.py # Async background job runner
│       └── utils/
│           ├── image_processing.py  # Resize, face crop, base64 encode/decode
│           └── qr.py               # HMAC-signed QR payloads
│
├── TryOn/                           # Xcode project
│   └── TryOn/
│       ├── TryOnApp.swift           # Entry point, deep link handling
│       ├── Info.plist               # URL scheme: genshot-fit://
│       ├── Config/
│       │   └── Secrets.swift        # API base URL
│       ├── Core/
│       │   ├── AppCoordinator.swift # State machine: onboarding | main
│       │   ├── AuthManager.swift    # Firebase Auth + Apple Sign-In
│       │   ├── APIClient.swift      # Actor-based HTTP client
│       │   └── Models.swift         # Codable types matching backend
│       ├── Onboarding/              # Welcome → Sign-In → Info → Scan → Photo
│       ├── Main/
│       │   ├── TryOn/              # Builder → Loading → Results gallery
│       │   ├── Wardrobe/           # Grid + QR scanner + import
│       │   └── Profile/            # Measurements + settings
│       └── Components/             # Reusable UI (FitScoreBadge, GlassCard, etc.)
│
└── extension/
    ├── manifest.json
    ├── background/
    │   └── service-worker.js        # API calls to backend
    ├── content/
    │   ├── content-script.js        # Message dispatch
    │   ├── inject-button.js         # "Try On" button injection
    │   ├── image-selector.js        # Product image picker
    │   └── extractors/
    │       ├── zara.js              # Zara DOM scraper
    │       ├── hm.js               # H&M DOM scraper
    │       └── generic.js          # Fallback: meta tags + JSON-LD
    └── popup/
        ├── popup.html
        ├── popup.css
        └── popup.js                 # Product preview + QR display
```

---

## Core Pipelines

### 1. Body Measurement (iOS + Backend)

The iOS app captures body data via three methods (best available wins):

| Method | Source | Accuracy |
|--------|--------|----------|
| LiDAR | ARKit depth mesh + MediaPipe pose | Highest |
| AR | Camera-only MediaPipe pose detection | Medium |
| Manual | User-entered measurements | Baseline |

Processing flow:
1. iOS captures AR frame + optional depth map + known height
2. Backend receives multipart upload at `POST /v1/body-scan`
3. `body_measurement.py` runs MediaPipe Pose (33 landmarks), calibrates pixels to cm using height, estimates circumferences via Ramanujan ellipse approximation
4. Returns `BodyVector` with per-metric confidence scores

### 2. Garment Import (Extension + QR + iOS)

```
Extension scrapes product page (Zara/H&M/generic)
  → POST /v1/import-sessions (creates session + HMAC signature)
  → Extension displays QR: genshot-fit://import?sid=<id>&sig=<sig>
  → iOS scans QR, deep-links into app
  → POST /v1/import-sessions/{id}/claim (adds items to wardrobe)
```

### 3. Virtual Try-On Image Generation

Two-stage pipeline for cross-angle consistency:

**Stage A — Internal References**
- Input: face crop (512px, if detected) + full-body reference (1024px) + garment images
- Generates front + profile reference images wearing the selected outfit
- These become consistency anchors for Stage B

**Stage B — Final Multi-Angle Outputs**
- Input: face crop + Stage A reference images + garment images
- Generates 4 angles: front, profile, three-quarter, back
- Each angle runs concurrently via `ThreadPoolExecutor`

Face crop extraction (`crop_face`):
- MediaPipe face detection (full-range model, `model_selection=1`)
- Bounding box expanded by 40% padding, cropped, resized to 512px max
- Passed as first reference image with prompt anchoring for identity consistency
- Graceful fallback: if no face detected, pipeline continues with full-body only

Model fallback: configured via `TRYON_IMAGE_MODELS` (comma-separated). Each angle attempts all models in order until one succeeds, with a single retry for any missing angles.

### 4. Fit Scoring

Per-garment-type weighted scoring:
- **Tops**: chest 35%, shoulder 25%, waist 20%, arm length 20%
- **Bottoms**: waist 35%, hip 35%, inseam 30%
- **Outerwear**: shoulder 30%, chest 30%, arm 20%, waist 20%

Compares user `BodyVector` against garment `SizeOption` measurement ranges. Accounts for fabric stretch tolerance. Returns 0-100 score, recommended size, and human-readable fit notes.

---

## API Endpoints

All endpoints except import-session creation and health check require a Firebase Auth bearer token.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Health check |
| `POST` | `/v1/import-sessions` | No | Create QR import session |
| `POST` | `/v1/import-sessions/{id}/claim` | Yes | Claim imported items to wardrobe |
| `POST` | `/v1/body-scan` | Yes | Upload AR scan, returns BodyVector |
| `POST` | `/v1/generations` | Yes | Create try-on generation job |
| `GET` | `/v1/generations/{id}` | Yes | Poll generation status + results |
| `GET` | `/v1/items` | Yes | List wardrobe items |
| `POST` | `/v1/items/{id}/save` | Yes | Save item to wardrobe |
| `GET` | `/v1/users/me` | Yes | Get user profile |
| `PUT` | `/v1/users/me` | Yes | Update user profile |

---

## Setup & Deployment

### Prerequisites

- Python 3.11+
- Xcode 15+ (iOS)
- `gcloud` CLI authenticated
- GCP project with billing enabled
- Firebase project with Apple Sign-In enabled

### Backend Environment

Create `backend/.env`:

```env
GCP_PROJECT_ID=your-project
GCS_BUCKET=your-bucket
FIRESTORE_DATABASE=your-db
HMAC_SECRET=your-secret

VERTEX_LOCATION=europe-west1
VERTEX_IMAGE_LOCATION=global
TRYON_IMAGE_MODELS=gemini-2.5-flash-image-preview
CORE_IMAGE_MODELS=gemini-2.5-flash-image,gemini-3-pro-image-preview

# Optional
REVE_API_KEY=
FIREBASE_CREDENTIALS_PATH=
CORS_ORIGINS=["*"]
LOG_LEVEL=INFO
```

### Deploy

```bash
# One-time GCP setup (APIs, Firestore, GCS bucket)
./deploy.sh setup

# Build & deploy to Cloud Run
./deploy.sh deploy

# Or run locally with Docker
./deploy.sh local
```

The deploy script:
1. Enables required GCP APIs (Cloud Run, Firestore, Storage, AI Platform, etc.)
2. Creates Firestore database and GCS bucket
3. Builds container via Cloud Build
4. Deploys to Cloud Run with all env vars

### iOS App

1. Open `TryOn/TryOn.xcodeproj` in Xcode
2. Update `TryOn/TryOn/Config/Secrets.swift` with deployed backend URL
3. Ensure `GoogleService-Info.plist` is present (Firebase config)
4. Build & run on physical device (AR/LiDAR requires real hardware)

### Chrome Extension

1. Open `chrome://extensions` in Chrome
2. Enable Developer Mode
3. Click "Load unpacked" and select the `extension/` directory
4. Navigate to a Zara or H&M product page to see the "Try On" button

---

## Dependencies

### Backend (`requirements.txt`)

| Package | Version | Purpose |
|---------|---------|---------|
| fastapi | 0.115.0 | Web framework |
| uvicorn | 0.30.6 | ASGI server |
| firebase-admin | 6.5.0 | Auth token verification |
| google-cloud-firestore | 2.19.0 | Document database |
| google-cloud-storage | 2.18.2 | Image storage |
| google-cloud-aiplatform | 1.78.0 | Vertex AI |
| google-genai | 1.14.0 | Gemini API client |
| pydantic | 2.9.2 | Data validation |
| pydantic-settings | 2.5.2 | Env var config |
| mediapipe | 0.10.18 | Pose + face detection |
| numpy | 1.26.4 | Array operations |
| Pillow | 10.4.0 | Image processing |
| beautifulsoup4 | 4.12.3 | Size chart HTML parsing |
| httpx | 0.28.1+ | HTTP client |
| qrcode | 7.4.2 | QR code generation |
| python-jose | 3.3.0 | JWT handling |

### iOS

- SwiftUI + Combine (system)
- ARKit + RealityKit (system)
- Vision framework (system)
- Firebase iOS SDK (SPM)
- MediaPipe iOS (pose detection)

---

## Docker

```dockerfile
FROM python:3.11-slim
# libgl1 + libglib2.0-0 required by MediaPipe
RUN apt-get update && apt-get install -y libgl1 libglib2.0-0
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
```

Cloud Run config: 1 CPU, 1 GiB RAM, 0-3 instances, 300s timeout.
