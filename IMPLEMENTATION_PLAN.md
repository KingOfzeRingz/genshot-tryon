# GenShot TryOn — Full Implementation Plan

## Context

Build an end-to-end virtual try-on system for a 24-hour hackathon (UCL AI Festival). The system bridges physical body measurements (via iPhone AR/LiDAR) with ecommerce garment data (via Chrome extension) to produce photorealistic try-on images with physics-aware fit scoring. Three components: iOS app, FastAPI backend on GCP, Chrome extension.

**Tech stack**: SwiftUI + ARKit + Vision (iOS), FastAPI + Firestore + GCS + Vertex AI + Gemini (backend), Manifest V3 (extension).

**Image generation**: Vertex AI `virtual-try-on-001` for front-view try-on composites, Gemini `gemini-3.1-flash-image-preview` (Nano Banana) for multi-angle prompt-based generation.

**AR approach**: Option A (full AR-based measurement) with Option B (manual input) as fallback.

---

## 1. Project Structure

### iOS App (`TryOn/TryOn/`)
```
TryOnApp.swift                    # Entry point, Firebase init, deep links
Config/
  GoogleService-Info.plist        # Firebase config
  Secrets.swift                   # API base URL
Core/
  AppCoordinator.swift            # State: onboarding | main
  AuthManager.swift               # Firebase Auth (Apple Sign-In)
  APIClient.swift                 # actor — all backend HTTP calls
  Models.swift                    # Codable types matching backend
Onboarding/
  OnboardingContainerView.swift   # NavigationStack wrapper
  WelcomeView.swift               # Splash screen
  SignInView.swift                # Apple Sign-In
  BasicInfoView.swift             # Gender, height, weight
  BodyScanView.swift              # AR camera + overlays
  BodyScanViewModel.swift         # ARSession + Vision pose + LiDAR depth
  ManualMeasurementsView.swift    # Fallback manual input
  PhotoUploadView.swift           # Reference photo capture
  AvatarGenerationView.swift      # Loading → "your twin is ready"
Main/
  MainTabView.swift               # 3 tabs
  TryOn/
    TryOnHomeView.swift           # Home — recent gens + "New TryOn"
    TryOnBuilderView.swift        # Slot picker (top/bottom/outerwear/shoes)
    GarmentSlotView.swift         # Individual slot card
    GenerationLoadingView.swift   # Poll + staged feedback
    GenerationResultView.swift    # Image gallery + fit score
    GenerationResultViewModel.swift
  Wardrobe/
    WardrobeView.swift            # Grid of saved items
    WardrobeViewModel.swift
    ItemDetailView.swift
    QRScannerView.swift           # AVCaptureSession QR reader
    QRScannerViewModel.swift      # Parse + claim import session
  Profile/
    ProfileView.swift             # User info + measurements + sign out
    EditMeasurementsView.swift    # Manual edit body vector
Components/
  FitScoreBadge.swift             # Circular score indicator
  SizeRecommendationCard.swift
  GarmentTypeIcon.swift
  AsyncImageView.swift
Extensions/
  Color+Brand.swift
```

**SPM Dependencies**: `firebase-ios-sdk` (FirebaseAuth, FirebaseFirestore)

### Backend (`backend/`)
```
Dockerfile
requirements.txt
.env.example
app/
  __init__.py
  main.py                         # FastAPI app, CORS, routers
  config.py                       # Pydantic BaseSettings
  auth/
    __init__.py
    firebase_auth.py              # Token verification
    dependencies.py               # Depends() helpers
  models/
    __init__.py
    body.py                       # BodyVector, BodyScanRequest
    item.py                       # Item, ImportSession, SizeGrid
    generation.py                 # GenerationRequest/Result, FitScore
    user.py                       # UserProfile
  routers/
    __init__.py
    import_sessions.py            # POST create, POST claim
    body_scan.py                  # POST multipart upload
    generations.py                # POST create, GET poll
    items.py                      # GET list, POST save
    users.py                      # GET/PUT me
  services/
    __init__.py
    body_measurement.py           # MediaPipe pose + depth fusion + circumference estimation
    size_chart_parser.py          # Deterministic Zara/H&M parsers
    size_chart_llm.py             # Gemini structured output fallback
    fit_engine.py                 # Constraint-based fit scoring
    image_generation.py           # Vertex AI try-on + Gemini multi-angle
    storage.py                    # GCS helpers
    firestore.py                  # Firestore CRUD
  workers/
    __init__.py
    generation_worker.py          # asyncio.Task background generation
  utils/
    __init__.py
    qr.py                         # HMAC signing/verification
    image_processing.py           # Resize, base64, format conversion
```

**Python Dependencies**:
```
fastapi==0.115.0
uvicorn[standard]==0.34.0
firebase-admin==6.6.0
google-cloud-storage==2.19.0
google-cloud-aiplatform==1.75.0
google-genai==1.12.0
pydantic==2.10.0
pydantic-settings==2.7.0
python-multipart==0.0.18
httpx==0.28.0
beautifulsoup4==4.12.3
mediapipe==0.10.21
numpy==2.2.0
Pillow==11.1.0
```

### Chrome Extension (`extension/`)
```
manifest.json                     # Manifest V3
background/
  service-worker.js               # API calls to backend
content/
  content-script.js               # Message handler, extractor dispatch
  extractors/
    zara.js                       # Zara DOM scraper
    hm.js                         # H&M DOM scraper
    generic.js                    # Fallback: meta tags + JSON-LD
popup/
  popup.html / popup.css / popup.js  # Product preview + QR code display
lib/
  qrcode.min.js                   # Vendored QR generator
icons/
  icon16.png / icon48.png / icon128.png
```

---

## 2. Data Models

### BodyVector
```json
{
  "height_cm": 178.0,
  "shoulder_cm": 45.0,
  "chest_cm": 98.0,
  "waist_cm": 82.0,
  "hip_cm": 96.0,
  "arm_length_cm": 62.0,
  "inseam_cm": 80.0,
  "confidence": {
    "height": 1.0, "shoulder": 0.85, "chest": 0.7,
    "waist": 0.7, "hip": 0.7, "arm": 0.8, "inseam": 0.75
  },
  "source": "AR"
}
```

### Item (Imported Garment)
```json
{
  "item_id": "abc123",
  "source": "extension",
  "source_url": "https://www.zara.com/...",
  "brand": "ZARA",
  "title": "Relaxed Fit Cotton Shirt",
  "garment_type": "top",
  "images": ["https://..."],
  "price": {"value": 29.99, "currency": "GBP"},
  "size_grid": {
    "unit": "cm",
    "sizes": {
      "S": {"chest_cm": [88, 92], "waist_cm": [72, 76], "length_cm": [70, 72]},
      "M": {"chest_cm": [96, 100], "waist_cm": [80, 84], "length_cm": [72, 74]}
    },
    "parse_confidence": 0.85
  },
  "material_hints": {"stretch": "low", "thickness": "thin"}
}
```

### GenerationRequest
```json
{
  "items": {
    "top": {"item_id": "abc123", "size": "AUTO"},
    "bottom": {"item_id": "def456", "size": "M"},
    "outerwear": null,
    "shoes": null
  },
  "auto_fill_missing": true,
  "angles": ["front", "three_quarter"],
  "render_style": "neutral"
}
```

### GenerationResult
```json
{
  "generation_id": "gen789",
  "status": "DONE",
  "images": [
    {"angle": "front", "url": "https://storage.googleapis.com/..."},
    {"angle": "three_quarter", "url": "https://storage.googleapis.com/..."}
  ],
  "fit": {
    "per_item": {
      "top": {
        "recommended_size": "M",
        "selected_size": "M",
        "fit_score": 0.87,
        "notes": ["Slightly relaxed in chest", "Good shoulder fit"]
      }
    },
    "overall_score": 0.87
  }
}
```

---

## 3. API Contract

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/import-sessions` | None | Extension creates import session |
| `POST` | `/v1/import-sessions/{id}/claim` | Firebase | App claims session via QR |
| `POST` | `/v1/body-scan` | Firebase | Upload AR scan data, get body vector |
| `POST` | `/v1/generations` | Firebase | Create generation request |
| `GET` | `/v1/generations/{id}` | Firebase | Poll generation status |
| `GET` | `/v1/items` | Firebase | List user's wardrobe items |
| `POST` | `/v1/items/{id}/save` | Firebase | Save/favorite item |
| `GET` | `/v1/users/me` | Firebase | Get user profile |
| `PUT` | `/v1/users/me` | Firebase | Update profile/body vector |

### Import Session Flow
1. Extension: `POST /v1/import-sessions` with extracted product data → returns `{session_id, sig, qr_payload}`
2. QR payload format: `genshot-fit://import?sid=<id>&sig=<signature>`
3. App scans QR → `POST /v1/import-sessions/{id}/claim` with sig → items added to wardrobe

### Generation Flow
1. `POST /v1/generations` → returns `{generation_id, status: "QUEUED"}`
2. Poll `GET /v1/generations/{id}` every 3 seconds
3. Status progression: `QUEUED` → `RUNNING` → `RENDERING` → `DONE` (or `FAILED`)
4. Progress stages: `PARSE` → `FIT_ANALYSIS` → `PROMPT_BUILD` → `IMAGE_GEN` → `POSTPROCESS`

---

## 4. Core Algorithms

### Body Measurement Pipeline (`body_measurement.py`)

1. **2D Pose Detection**: MediaPipe Pose → 33 landmarks (x, y, visibility)
2. **Person Segmentation**: MediaPipe Selfie Segmentation → body mask
3. **Pixel-to-Real Conversion**:
   - With LiDAR depth: sample depth at each joint → camera intrinsics → world coordinates
   - Without depth: measure pixel distance head-to-ankle → compute px/cm ratio using user height
4. **Width Measurements** (frontal 2D):
   - Shoulder width: left_shoulder ↔ right_shoulder
   - Hip width: left_hip ↔ right_hip
   - Arm length: shoulder → elbow → wrist (summed segments)
   - Inseam: hip → ankle
5. **Circumference Estimation**:
   - With LiDAR: Ramanujan ellipse — `circumference ≈ π × √(2(w/2)² + 2(d/2)²)`
   - Without LiDAR: heuristic — `chest ≈ shoulder_width × 2.8`, `waist ≈ width × π × 0.9`, `hip ≈ width × π × 0.95`
   - Gender-based adjustment factors applied
6. **Confidence Scoring**: Per-measurement based on landmark visibility, depth availability, anatomical range check

### Fit Scoring Engine (`fit_engine.py`)

Per-size score computation:
1. For each measurement: compute distance to garment size range
2. Weight by garment type:
   - **Tops**: chest 40%, shoulders 30%, waist 20%, arm_length 10%
   - **Bottoms**: waist 35%, hip 35%, inseam 30%
   - **Outerwear**: chest 35%, shoulders 35%, arm_length 20%, waist 10%
3. Stretch tolerance: expand acceptable range by 5–8% for stretchy materials
4. Score: `100 - sum(weighted_deviations)`, clamped [0, 100]
5. Notes: generated from worst-fitting dimensions ("Chest may be snug in M")

### Image Generation (`image_generation.py`)

- **Front angle**: Vertex AI `virtual-try-on-001` — person image + product image → composite
- **45° angle**: Gemini `gemini-3.1-flash-image-preview` — reference image + structured prompt with body proportions + fit cues
- Fit cues derived from scoring: "subtle fabric tension" (tight), "relaxed drape" (oversized), "natural fit" (perfect)

### Size Chart Parsing (`size_chart_parser.py` + `size_chart_llm.py`)

- **Deterministic** (Zara/H&M): BeautifulSoup table extraction, header mapping, unit normalization
- **LLM fallback**: Gemini with `response_mime_type="application/json"` + schema for structured extraction

---

## 5. iOS Architecture Details

### Navigation
- `AppCoordinator` (`@Observable`): controls `appState` enum (`.loading` / `.onboarding` / `.main`)
- Onboarding: `NavigationStack` with typed `[OnboardingStep]` path
- Main: `TabView` with 3 tabs (Try On, Wardrobe, Profile)

### AR Body Scan (Most Complex Component)
- `ARViewContainer: UIViewRepresentable` wrapping `ARSCNView`
- `ARWorldTrackingConfiguration` with `.bodyDetection` frame semantics (if available)
- Per-frame: run `VNDetectHumanBodyPoseRequest` in detached task → publish joint positions
- LiDAR: read `frame.smoothedSceneDepth?.depthMap` → 16-bit PNG for upload
- Capture: 2-second burst → pick highest-confidence frame → package RGB + depth + intrinsics + transform
- Overlay: silhouette guide + live skeleton joints rendered in SwiftUI layer

### Networking
- `actor APIClient` with `URLSession` async/await
- Auto-attaches `Authorization: Bearer <idToken>` from `AuthManager`
- Typed methods: `submitBodyScan()`, `claimImportSession()`, `createGeneration()`, `pollGeneration()`, etc.

### Deep Links
- URL scheme: `genshot-fit://`
- Registered in `Info.plist` as `CFBundleURLTypes`
- `TryOnApp` handles `.onOpenURL` → parse `sid` + `sig` → navigate to claim flow

---

## 6. Chrome Extension Details

### Manifest V3 Config
- `permissions`: `activeTab`, `scripting`
- `host_permissions`: `https://www.zara.com/*`, `https://www2.hm.com/*`, `https://*/*`
- Declarative content scripts for Zara/H&M
- Generic extractor injected on-demand via `chrome.scripting.executeScript()`

### Extraction Strategy
- **Zara**: `.product-detail-info__header-name` (title), `.money-amount__main` (price), `.product-detail-images img` (images), `.size-guide-table` (sizes)
- **H&M**: `.product-item-headline` (title), `.ProductPrice` (price), `.size-guide table` (sizes)
- **Generic**: `og:title`, `og:image` meta tags, JSON-LD `@type: "Product"`, any HTML table with size-like headers

### QR Code
- Generated using vendored `qrcode.min.js`
- Encodes: `genshot-fit://import?sid=<session_id>&sig=<hmac_signature>`
- Displayed in popup with "Scan in TryOn app" instruction

---

## 7. Implementation Timeline (24 Hours)

### Phase 0: Setup (Hours 0–1)
- [ ] GCP project: enable Vertex AI, Cloud Run, Firestore, GCS
- [ ] Firebase project: enable Apple Sign-In, add iOS app, download config
- [ ] iOS: add Firebase SPM, create directory structure
- [ ] Backend: scaffold FastAPI app, install dependencies
- [ ] Extension: create manifest + directory structure

### Phase 1: Backend Core (Hours 1–5)
- [ ] Config + Pydantic models + auth middleware
- [ ] Import sessions router + HMAC QR signing
- [ ] Body scan endpoint + MediaPipe measurement pipeline
- [ ] Fit engine + size chart parsers (Zara/H&M + Gemini fallback)
- [ ] Generation router + worker + Vertex AI + Gemini integration

### Phase 2: Chrome Extension (Hours 5–7)
- [ ] Zara/H&M/generic content script extractors
- [ ] Service worker API integration
- [ ] Popup UI with QR code display

### Phase 3: iOS App (Hours 7–14)
- [ ] Core: Models, APIClient, AuthManager, AppCoordinator
- [ ] Onboarding: Welcome, Sign-In (Apple), Basic Info
- [ ] **AR Body Scan**: ARViewContainer, Vision pose, LiDAR depth, capture flow
- [ ] Manual measurements fallback
- [ ] Photo upload + avatar loading screen
- [ ] Main tabs: Wardrobe, QR scanner, TryOn builder, generation results, profile

### Phase 4: Integration + Polish (Hours 14–20)
- [ ] End-to-end flow testing
- [ ] UI components: FitScoreBadge, SizeRecommendationCard
- [ ] Animations, loading states, error handling
- [ ] Deploy backend to Cloud Run
- [ ] Test on physical iPhone

### Phase 5: Demo Prep (Hours 20–24)
- [ ] Pre-seed demo items (Zara shirt, H&M jeans)
- [ ] Pre-generate backup results
- [ ] Test fallback paths
- [ ] Screen recording backup
- [ ] Presentation talking points

---

## 8. What's Fully Implemented vs Simulated

| Feature | Status | Notes |
|---------|--------|-------|
| Firebase Apple Sign-In | **Full** | |
| 2D body pose detection (Vision) | **Full** | 19 joint keypoints |
| Height-calibrated measurements | **Full** | Pixel distance → cm via known height |
| LiDAR depth fusion | **Full** | Graceful fallback when unavailable |
| Circumference estimation (no depth) | **Simulated** | Anatomical ratio heuristic |
| QR import pipeline | **Full** | Extension → backend → app |
| Vertex AI virtual try-on | **Full** | `virtual-try-on-001` GA API |
| Gemini multi-angle generation | **Full** | `gemini-3.1-flash-image-preview` |
| Zara/H&M size chart parsing | **Full** | Deterministic DOM parsers |
| LLM size chart fallback | **Full** | Gemini structured output |
| Fit scoring engine | **Full** | Weighted constraint-based |
| 3D avatar / mesh | **Skipped** | Body vector + photo instead |
| Fabric physics / drape | **Simulated** | Stretch tolerance % only |
| Side view (3rd angle) | **Skipped** | Front + 45° only |

---

## 9. GCP Infrastructure

### Services Used
- **Cloud Run**: Backend deployment (min-instances=1 to avoid cold starts)
- **Firestore**: `users/{uid}`, `users/{uid}/items/{item_id}`, `users/{uid}/generations/{gen_id}`, `import_sessions/{sid}`
- **Cloud Storage**: `genshot-tryon-media` bucket for user uploads + generated images
- **Vertex AI**: `virtual-try-on-001` model
- **Gemini API** (via Vertex AI): `gemini-3.1-flash-image-preview` for image generation + `gemini-2.5-flash` for size chart parsing
- **Firebase Auth**: Apple Sign-In provider

### Environment Variables (Backend)
```
GOOGLE_CLOUD_PROJECT=genshot-tryon
GCS_BUCKET=genshot-tryon-media
VERTEX_AI_LOCATION=us-central1
QR_SIGNING_SECRET=<random-hex-32>
GOOGLE_GENAI_USE_VERTEXAI=True
GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
```

---

## 10. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| AR body detection fails on device | Manual measurements fallback built into flow |
| Vertex AI quota/latency | Pre-generate results + Gemini as backup path |
| Size chart HTML changes | LLM fallback handles unknown structures |
| Deep link doesn't open app | Have app pre-installed for demo |
| Firestore security rules | Permissive rules for hackathon: `allow read, write: if request.auth != null` |
| Swift 6 concurrency issues | Set `SWIFT_STRICT_CONCURRENCY = minimal` if needed |
| Cloud Run cold starts | `--min-instances=1` on deploy |

---

## 11. Parallel Workstreams (2-3 Developers)

### 2 Developers
- **Dev A** (Hours 0–14): Backend + Extension → deploy by hour 8, extension by hour 7, then integration
- **Dev B** (Hours 0–14): iOS app → mock API initially, integrate when backend is live
- **Both** (Hours 14–24): Integration, polish, demo prep

### 3 Developers
- **Dev A**: Backend (hours 0–10)
- **Dev B**: iOS app (hours 0–16)
- **Dev C**: Extension (hours 0–4) → UI components (hours 4–8) → demo prep (hours 8–16)

### Shared Contract
Agree on exact JSON shapes (Section 2) before splitting. Swift `Codable` structs must mirror Python `Pydantic` models.

---

## 12. Demo Narrative (UCL AI Festival)

**Framing**: "Multimodal body-garment alignment engine integrating computer vision, LiDAR depth sensing, and generative AI"

**3-minute flow**:
1. Chrome → Zara product page → click GenShot extension → QR appears
2. TryOn app → scan QR → item appears in wardrobe
3. Select item → Generate → loading with "Analyzing fit..." stages
4. Results: 2 images (front + 45°), fit score "87/100", size "M – Good fit"
5. Show profile with AR-derived body measurements

**Key line**: "We embed geometric and measurement constraints into generative pipelines to reduce hallucinated fit outcomes."
