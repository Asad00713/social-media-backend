# Canva API Documentation

## Overview

Canva integration allows users to create and edit designs directly within your app, then export them for use in social media posts.

**Base URL:** `/canva`

**Authentication:** Most endpoints require JWT authentication (Bearer token) + Canva access token

**Environment Variables:**
```env
CANVA_CLIENT_ID=OC-AZvRV2QYLkiX
CANVA_CLIENT_SECRET=your_canva_client_secret
```

---

## OAuth Flow

### 1. Initiate OAuth

Start the Canva OAuth flow to get user authorization.

**Endpoint:** `POST /canva/oauth/initiate`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Body:**
```json
{
  "redirectUrl": "http://localhost:3001/canva/callback"  // Optional: frontend redirect URL
}
```

**Response:**
```json
{
  "authorizationUrl": "https://www.canva.com/api/oauth/authorize?client_id=...",
  "state": "abc123..."
}
```

**Frontend Flow:**
1. Call this endpoint
2. Redirect user to `authorizationUrl`
3. User logs in and authorizes
4. User is redirected to `/canva/oauth/callback`
5. Backend redirects to frontend with tokens

---

### 2. OAuth Callback (Automatic)

**Endpoint:** `GET /canva/oauth/callback`

This is called by Canva after authorization. Redirects to frontend:

**Success:**
```
{frontendUrl}/canva/connect/success?accessToken=...&refreshToken=...&expiresIn=...&userId=...&displayName=...
```

**Error:**
```
{frontendUrl}/canva/connect/error?error=...&description=...
```

---

### 3. Refresh Token

Refresh an expired access token.

**Endpoint:** `POST /canva/oauth/refresh`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Body:**
```json
{
  "refreshToken": "canva_refresh_token"
}
```

**Response:**
```json
{
  "accessToken": "new_access_token",
  "refreshToken": "new_refresh_token",
  "expiresIn": 3600,
  "tokenType": "Bearer",
  "scope": "design:content:read design:content:write..."
}
```

---

### 4. Get Current User

Get the authenticated Canva user's info.

**Endpoint:** `POST /canva/me`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Body:**
```json
{
  "accessToken": "canva_access_token"
}
```

**Response:**
```json
{
  "userId": "UAFdkjh3k2...",
  "displayName": "John Doe"
}
```

---

## Design Endpoints

### 5. Create Design

Create a new design and get an edit URL for embedding.

**Endpoint:** `POST /canva/designs`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Body:**
```json
{
  "accessToken": "canva_access_token",
  "designType": "Instagram Post",
  "title": "My Social Media Post",
  "assetId": "optional_asset_id"
}
```

**Available Design Types:**
- `Instagram Post`
- `Facebook Post`
- `Twitter Post`
- `Pinterest Pin`
- `YouTube Thumbnail`
- `Presentation`
- `Document`
- `Whiteboard`
- `Video`

**Response:**
```json
{
  "id": "DAFdkjh3k2...",
  "title": "My Social Media Post",
  "url": "https://www.canva.com/design/DAFdkjh3k2.../view",
  "editUrl": "https://www.canva.com/design/DAFdkjh3k2.../edit",
  "thumbnail": {
    "url": "https://...",
    "width": 800,
    "height": 800
  },
  "createdAt": "2026-01-18T12:00:00Z",
  "updatedAt": "2026-01-18T12:00:00Z"
}
```

**Note:** The `editUrl` can be opened in an iframe or popup for users to edit their design.

---

### 6. List Designs

Get user's existing designs.

**Endpoint:** `POST /canva/designs/list`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Body:**
```json
{
  "accessToken": "canva_access_token",
  "limit": 20,
  "continuation": "optional_continuation_token"
}
```

**Response:**
```json
{
  "designs": [
    {
      "id": "DAFdkjh3k2...",
      "title": "My Design",
      "url": "https://www.canva.com/design/...",
      "editUrl": "https://www.canva.com/design/.../edit",
      "thumbnail": {
        "url": "https://...",
        "width": 800,
        "height": 800
      },
      "createdAt": "2026-01-18T12:00:00Z",
      "updatedAt": "2026-01-18T12:00:00Z"
    }
  ],
  "continuation": "next_page_token"
}
```

---

### 7. Get Design

Get a specific design by ID.

**Endpoint:** `POST /canva/designs/:designId`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Body:**
```json
{
  "accessToken": "canva_access_token"
}
```

**Response:**
```json
{
  "id": "DAFdkjh3k2...",
  "title": "My Design",
  "url": "https://www.canva.com/design/...",
  "editUrl": "https://www.canva.com/design/.../edit",
  "thumbnail": {
    "url": "https://...",
    "width": 800,
    "height": 800
  },
  "createdAt": "2026-01-18T12:00:00Z",
  "updatedAt": "2026-01-18T12:00:00Z"
}
```

---

## Export Endpoints

### 8. Export Design (Start Job)

Start an export job for a design.

**Endpoint:** `POST /canva/designs/:designId/export`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Body:**
```json
{
  "accessToken": "canva_access_token",
  "format": "png",
  "quality": "high",
  "pages": [1, 2]
}
```

**Available Formats:**
- `png` - PNG image
- `jpg` - JPEG image
- `pdf` - PDF document
- `mp4` - Video
- `gif` - Animated GIF

**Quality Options:**
- `low`
- `medium`
- `high`

**Response:**
```json
{
  "id": "export_job_id",
  "status": "in_progress",
  "urls": null,
  "error": null
}
```

---

### 9. Get Export Status

Check the status of an export job.

**Endpoint:** `POST /canva/designs/:designId/export/:exportId/status`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Body:**
```json
{
  "accessToken": "canva_access_token"
}
```

**Response:**
```json
{
  "id": "export_job_id",
  "status": "completed",
  "urls": [
    "https://export.canva.com/..."
  ],
  "error": null
}
```

**Status Values:**
- `pending` - Job queued
- `in_progress` - Processing
- `completed` - Done, URLs available
- `failed` - Error occurred

---

### 10. Export and Wait (Recommended)

Export a design and wait for completion. Returns download URLs directly.

**Endpoint:** `POST /canva/designs/:designId/export-and-wait`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Body:**
```json
{
  "accessToken": "canva_access_token",
  "format": "png",
  "quality": "high"
}
```

**Response:**
```json
{
  "exportId": "export_job_id",
  "status": "completed",
  "urls": [
    "https://export.canva.com/abc123.png"
  ]
}
```

**Note:** This endpoint waits up to 60 seconds for the export to complete.

---

## Asset Endpoints

### 11. Upload Asset

Upload an image/video to Canva to use in designs.

**Endpoint:** `POST /canva/assets/upload`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Body:**
```json
{
  "accessToken": "canva_access_token",
  "name": "my-image.jpg",
  "mediaUrl": "https://example.com/image.jpg"
}
```

**Response:**
```json
{
  "assetId": "asset_123...",
  "status": "completed"
}
```

**Use Case:** Upload an image, get `assetId`, then pass it to `createDesign` to pre-fill the design.

---

## Utility Endpoints

### 12. Get Design Types

Get list of available design types.

**Endpoint:** `GET /canva/design-types`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Response:**
```json
[
  "Instagram Post",
  "Facebook Post",
  "Twitter Post",
  "Pinterest Pin",
  "YouTube Thumbnail",
  "Presentation",
  "Document",
  "Whiteboard",
  "Video"
]
```

---

## Frontend Integration Example

### Complete Flow: Create, Edit, Export

```typescript
// 1. Create a design
const createResponse = await fetch('/canva/designs', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    accessToken: canvaAccessToken,
    designType: 'Instagram Post',
    title: 'My Post',
  }),
});
const design = await createResponse.json();

// 2. Open editor in iframe/popup
const editorWindow = window.open(design.editUrl, 'canva-editor', 'width=1200,height=800');

// 3. When user is done editing, export the design
const exportResponse = await fetch(`/canva/designs/${design.id}/export-and-wait`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    accessToken: canvaAccessToken,
    format: 'png',
    quality: 'high',
  }),
});
const exported = await exportResponse.json();

// 4. Use the exported image URL in your post
console.log('Image URL:', exported.urls[0]);
```

### Embedding Canva Editor in iframe

```html
<iframe
  src="${design.editUrl}"
  width="100%"
  height="600"
  frameborder="0"
  allow="clipboard-read; clipboard-write"
></iframe>
```

---

## Error Responses

**400 Bad Request:**
```json
{
  "statusCode": 400,
  "message": "Canva credentials not configured",
  "error": "Bad Request"
}
```

**401 Unauthorized:**
```json
{
  "statusCode": 401,
  "message": "Canva access token expired",
  "error": "Unauthorized"
}
```

---

## Rate Limits

Canva API has rate limits. If you hit them, you'll receive a 429 error. Implement exponential backoff for retries.

---

## OAuth Scopes Used

| Scope | Description |
|-------|-------------|
| `design:content:read` | Read design content |
| `design:content:write` | Create/modify designs |
| `design:meta:read` | Read design metadata |
| `asset:read` | Read assets |
| `asset:write` | Upload assets |
| `profile:read` | Read user profile |
