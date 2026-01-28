# Unsplash API Documentation

## Overview

Unsplash integration provides free high-resolution stock photos for use in social media posts.

**Base URL:** `/channels/unsplash`

**Authentication:** All endpoints require JWT authentication (Bearer token)

**Environment Variable:**
```env
UNSPLASH_ACCESS_KEY=your_unsplash_access_key
```

Get your API key from: https://unsplash.com/developers

**Rate Limits:**
- Demo: 50 requests/hour
- Production: Apply for higher limits

---

## Photo Endpoints

### 1. Search Photos

Search for photos by keyword.

**Endpoint:** `GET /channels/unsplash/search`

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search term (e.g., "nature", "business") |
| `page` | number | No | Page number (default: 1) |
| `perPage` | number | No | Results per page (default: 20, max: 30) |
| `orientation` | string | No | `landscape`, `portrait`, or `squarish` |
| `color` | string | No | Color filter: `black_and_white`, `black`, `white`, `yellow`, `orange`, `red`, `purple`, `magenta`, `green`, `teal`, `blue` |

**Example Request:**
```
GET /channels/unsplash/search?query=business&orientation=landscape&perPage=20
```

**Example Response:**
```json
{
  "total": 10000,
  "totalPages": 500,
  "results": [
    {
      "id": "abc123xyz",
      "width": 5472,
      "height": 3648,
      "color": "#0c0c0c",
      "blurHash": "LGF5]+Yk^6#M@-5c,1J5@[or[Q6.",
      "description": "Office workspace with laptop",
      "altDescription": "silver MacBook beside space gray iPhone 6 and clear drinking glass",
      "urls": {
        "raw": "https://images.unsplash.com/photo-1497215728101-856f4ea42174?ixid=...",
        "full": "https://images.unsplash.com/photo-1497215728101-856f4ea42174?ixid=...&q=100",
        "regular": "https://images.unsplash.com/photo-1497215728101-856f4ea42174?ixid=...&w=1080",
        "small": "https://images.unsplash.com/photo-1497215728101-856f4ea42174?ixid=...&w=400",
        "thumb": "https://images.unsplash.com/photo-1497215728101-856f4ea42174?ixid=...&w=200"
      },
      "links": {
        "self": "https://api.unsplash.com/photos/abc123xyz",
        "html": "https://unsplash.com/photos/abc123xyz",
        "download": "https://unsplash.com/photos/abc123xyz/download",
        "downloadLocation": "https://api.unsplash.com/photos/abc123xyz/download?ixid=..."
      },
      "user": {
        "id": "user123",
        "username": "johndoe",
        "name": "John Doe",
        "profileUrl": "https://unsplash.com/@johndoe",
        "profileImage": "https://images.unsplash.com/profile-..."
      }
    }
  ]
}
```

---

### 2. Get Random Photos

Get random photos, optionally filtered by query.

**Endpoint:** `GET /channels/unsplash/random`

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Filter by search term |
| `orientation` | string | No | `landscape`, `portrait`, or `squarish` |
| `count` | number | No | Number of photos (default: 1, max: 30) |

**Example Request:**
```
GET /channels/unsplash/random?query=nature&orientation=landscape&count=5
```

**Example Response:**
```json
[
  {
    "id": "xyz789abc",
    "width": 4000,
    "height": 3000,
    "color": "#264026",
    "blurHash": "LGF5]+Yk^6#M@-5c,1J5@[or[Q6.",
    "description": "Beautiful mountain landscape",
    "altDescription": "green mountains under white clouds",
    "urls": {
      "raw": "https://images.unsplash.com/photo-...",
      "full": "https://images.unsplash.com/photo-...&q=100",
      "regular": "https://images.unsplash.com/photo-...&w=1080",
      "small": "https://images.unsplash.com/photo-...&w=400",
      "thumb": "https://images.unsplash.com/photo-...&w=200"
    },
    "links": {
      "self": "https://api.unsplash.com/photos/xyz789abc",
      "html": "https://unsplash.com/photos/xyz789abc",
      "download": "https://unsplash.com/photos/xyz789abc/download",
      "downloadLocation": "https://api.unsplash.com/photos/xyz789abc/download?ixid=..."
    },
    "user": {
      "id": "user456",
      "username": "naturephotographer",
      "name": "Nature Photographer",
      "profileUrl": "https://unsplash.com/@naturephotographer",
      "profileImage": "https://images.unsplash.com/profile-..."
    }
  }
]
```

---

### 3. Get Curated Photos

Get popular/editorial photos.

**Endpoint:** `GET /channels/unsplash/curated`

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | number | No | Page number (default: 1) |
| `perPage` | number | No | Results per page (default: 20, max: 30) |

**Example Request:**
```
GET /channels/unsplash/curated?page=1&perPage=10
```

**Example Response:**
```json
[
  {
    "id": "popular123",
    "width": 5000,
    "height": 3333,
    "color": "#f3d9c0",
    "blurHash": "LMK_z*9t4T?aKOV@-:t8E1r=E1NG",
    "description": "Trending photo of the day",
    "altDescription": "aerial view of city buildings",
    "urls": {
      "raw": "https://images.unsplash.com/photo-...",
      "full": "https://images.unsplash.com/photo-...&q=100",
      "regular": "https://images.unsplash.com/photo-...&w=1080",
      "small": "https://images.unsplash.com/photo-...&w=400",
      "thumb": "https://images.unsplash.com/photo-...&w=200"
    },
    "links": { ... },
    "user": { ... }
  }
]
```

---

### 4. Get Photo by ID

Get details for a specific photo.

**Endpoint:** `GET /channels/unsplash/photos/:photoId`

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `photoId` | string | Yes | The Unsplash photo ID |

**Example Request:**
```
GET /channels/unsplash/photos/abc123xyz
```

**Example Response:**
```json
{
  "id": "abc123xyz",
  "width": 5472,
  "height": 3648,
  "color": "#0c0c0c",
  "blurHash": "LGF5]+Yk^6#M@-5c,1J5@[or[Q6.",
  "description": "Office workspace with laptop",
  "altDescription": "silver MacBook beside space gray iPhone 6",
  "urls": {
    "raw": "https://images.unsplash.com/photo-...",
    "full": "https://images.unsplash.com/photo-...&q=100",
    "regular": "https://images.unsplash.com/photo-...&w=1080",
    "small": "https://images.unsplash.com/photo-...&w=400",
    "thumb": "https://images.unsplash.com/photo-...&w=200"
  },
  "links": {
    "self": "https://api.unsplash.com/photos/abc123xyz",
    "html": "https://unsplash.com/photos/abc123xyz",
    "download": "https://unsplash.com/photos/abc123xyz/download",
    "downloadLocation": "https://api.unsplash.com/photos/abc123xyz/download?ixid=..."
  },
  "user": {
    "id": "user123",
    "username": "johndoe",
    "name": "John Doe",
    "profileUrl": "https://unsplash.com/@johndoe",
    "profileImage": "https://images.unsplash.com/profile-..."
  }
}
```

---

### 5. Track Download (Required!)

**IMPORTANT:** Unsplash API guidelines **require** you to trigger a download tracking event when a user selects/downloads a photo. This helps photographers get credited.

**Endpoint:** `POST /channels/unsplash/download`

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `downloadLocation` | string | Yes | The `links.downloadLocation` URL from the photo |

**Example Request:**
```
POST /channels/unsplash/download
Content-Type: application/json

{
  "downloadLocation": "https://api.unsplash.com/photos/abc123xyz/download?ixid=..."
}
```

**Example Response:**
```json
{
  "success": true,
  "message": "Download tracked successfully"
}
```

---

## Usage in Frontend

### Complete Flow Example

```javascript
// 1. Search for photos
const searchResults = await fetch('/channels/unsplash/search?query=business&perPage=20', {
  headers: { 'Authorization': `Bearer ${token}` }
}).then(res => res.json());

// 2. Display photos to user
displayPhotos(searchResults.results);

// 3. When user selects a photo, track the download
async function onPhotoSelect(photo) {
  // Track download (REQUIRED by Unsplash)
  await fetch('/channels/unsplash/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      downloadLocation: photo.links.downloadLocation
    })
  });

  // Use the photo URL for your post
  const imageUrl = photo.urls.regular; // or full, small, etc.

  return imageUrl;
}
```

### Image URL Sizes

| Size | Description | Typical Use |
|------|-------------|-------------|
| `raw` | Original uncompressed | Full quality download |
| `full` | Full resolution JPEG | High-quality use |
| `regular` | 1080px width | Standard web use |
| `small` | 400px width | Thumbnails, previews |
| `thumb` | 200px width | Small thumbnails |

### BlurHash

The `blurHash` field can be used to show a placeholder while the image loads. Use a BlurHash library to decode and display it:

```javascript
import { decode } from 'blurhash';

const pixels = decode(photo.blurHash, 32, 32);
// Convert to canvas/image for placeholder
```

---

## Attribution

Unsplash requires attribution when using photos. Include photographer credit:

```
Photo by [Photographer Name] on Unsplash
```

The user info is available in the response:
- `user.name` - Photographer's display name
- `user.profileUrl` - Link to photographer's Unsplash profile

---

## Error Responses

### 400 Bad Request
```json
{
  "message": "Query parameter is required",
  "error": "Bad Request",
  "statusCode": 400
}
```

### 401 Unauthorized
```json
{
  "message": "Unauthorized",
  "statusCode": 401
}
```

### 500 Internal Server Error
```json
{
  "message": "Unsplash API not configured. Set UNSPLASH_ACCESS_KEY environment variable.",
  "error": "Bad Request",
  "statusCode": 400
}
```
