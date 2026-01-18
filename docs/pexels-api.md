# Pexels API Documentation

## Overview

Pexels integration provides free stock photos and videos for use in social media posts.

**Base URL:** `/pexels`

**Authentication:** All endpoints require JWT authentication (Bearer token)

**Environment Variable:**
```env
PEXELS_API_KEY=your_pexels_api_key
```

Get your API key from: https://www.pexels.com/api/

---

## Photo Endpoints

### 1. Search Photos

Search for photos by keyword.

**Endpoint:** `GET /pexels/photos/search`

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search term (e.g., "nature", "business") |
| `orientation` | string | No | `landscape`, `portrait`, or `square` |
| `size` | string | No | `large`, `medium`, or `small` |
| `color` | string | No | Hex color (e.g., `FF0000`) or color name (e.g., `red`, `blue`) |
| `locale` | string | No | Locale code (e.g., `en-US`, `pt-BR`) |
| `page` | number | No | Page number (default: 1) |
| `perPage` | number | No | Results per page (default: 15, max: 80) |

**Example Request:**
```
GET /pexels/photos/search?query=business&orientation=landscape&perPage=20
```

**Example Response:**
```json
{
  "items": [
    {
      "id": 3184291,
      "width": 6000,
      "height": 4000,
      "url": "https://www.pexels.com/photo/...",
      "photographer": "fauxels",
      "photographerUrl": "https://www.pexels.com/@fauxels",
      "photographerId": 1092082,
      "avgColor": "#8B7355",
      "src": {
        "original": "https://images.pexels.com/photos/3184291/pexels-photo-3184291.jpeg",
        "large2x": "https://images.pexels.com/photos/3184291/pexels-photo-3184291.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940",
        "large": "https://images.pexels.com/photos/3184291/pexels-photo-3184291.jpeg?auto=compress&cs=tinysrgb&h=650&w=940",
        "medium": "https://images.pexels.com/photos/3184291/pexels-photo-3184291.jpeg?auto=compress&cs=tinysrgb&h=350",
        "small": "https://images.pexels.com/photos/3184291/pexels-photo-3184291.jpeg?auto=compress&cs=tinysrgb&h=130",
        "portrait": "https://images.pexels.com/photos/3184291/pexels-photo-3184291.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
        "landscape": "https://images.pexels.com/photos/3184291/pexels-photo-3184291.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200",
        "tiny": "https://images.pexels.com/photos/3184291/pexels-photo-3184291.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280"
      },
      "alt": "Photo of People Near Wooden Table"
    }
  ],
  "totalResults": 8000,
  "page": 1,
  "perPage": 20,
  "nextPage": "https://api.pexels.com/v1/search?page=2&per_page=20&query=business",
  "prevPage": null
}
```

---

### 2. Get Curated Photos

Get editor's choice / featured photos.

**Endpoint:** `GET /pexels/photos/curated`

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | number | No | Page number (default: 1) |
| `perPage` | number | No | Results per page (default: 15, max: 80) |

**Example Request:**
```
GET /pexels/photos/curated?page=1&perPage=10
```

**Example Response:**
```json
{
  "items": [
    {
      "id": 2014422,
      "width": 3024,
      "height": 3024,
      "url": "https://www.pexels.com/photo/...",
      "photographer": "Joey Kyber",
      "photographerUrl": "https://www.pexels.com/@joey-kyber-137055",
      "photographerId": 137055,
      "avgColor": "#978E82",
      "src": {
        "original": "...",
        "large2x": "...",
        "large": "...",
        "medium": "...",
        "small": "...",
        "portrait": "...",
        "landscape": "...",
        "tiny": "..."
      },
      "alt": "Brown Rocks During Golden Hour"
    }
  ],
  "totalResults": 8000,
  "page": 1,
  "perPage": 10,
  "nextPage": "https://api.pexels.com/v1/curated?page=2&per_page=10",
  "prevPage": null
}
```

---

### 3. Get Photo by ID

Get a specific photo by its ID.

**Endpoint:** `GET /pexels/photos/:id`

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Pexels photo ID |

**Example Request:**
```
GET /pexels/photos/3184291
```

**Example Response:**
```json
{
  "id": 3184291,
  "width": 6000,
  "height": 4000,
  "url": "https://www.pexels.com/photo/...",
  "photographer": "fauxels",
  "photographerUrl": "https://www.pexels.com/@fauxels",
  "photographerId": 1092082,
  "avgColor": "#8B7355",
  "src": {
    "original": "...",
    "large2x": "...",
    "large": "...",
    "medium": "...",
    "small": "...",
    "portrait": "...",
    "landscape": "...",
    "tiny": "..."
  },
  "alt": "Photo of People Near Wooden Table"
}
```

---

## Video Endpoints

### 4. Search Videos

Search for videos by keyword.

**Endpoint:** `GET /pexels/videos/search`

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search term (e.g., "ocean", "city") |
| `orientation` | string | No | `landscape`, `portrait`, or `square` |
| `size` | string | No | `large`, `medium`, or `small` |
| `locale` | string | No | Locale code (e.g., `en-US`) |
| `page` | number | No | Page number (default: 1) |
| `perPage` | number | No | Results per page (default: 15, max: 80) |

**Example Request:**
```
GET /pexels/videos/search?query=ocean&orientation=landscape&perPage=10
```

**Example Response:**
```json
{
  "items": [
    {
      "id": 1093662,
      "width": 1920,
      "height": 1080,
      "url": "https://www.pexels.com/video/...",
      "image": "https://images.pexels.com/videos/1093662/free-video-1093662.jpg",
      "duration": 22,
      "user": {
        "id": 631997,
        "name": "Engin Akyurt",
        "url": "https://www.pexels.com/@enginakyurt"
      },
      "videoFiles": [
        {
          "id": 48035,
          "quality": "hd",
          "fileType": "video/mp4",
          "width": 1920,
          "height": 1080,
          "fps": 23.976,
          "link": "https://player.vimeo.com/external/..."
        },
        {
          "id": 48036,
          "quality": "sd",
          "fileType": "video/mp4",
          "width": 960,
          "height": 540,
          "fps": 23.976,
          "link": "https://player.vimeo.com/external/..."
        }
      ],
      "videoPictures": [
        {
          "id": 134906,
          "picture": "https://images.pexels.com/videos/1093662/pictures/preview-0.jpg",
          "nr": 0
        }
      ]
    }
  ],
  "totalResults": 5000,
  "page": 1,
  "perPage": 10,
  "nextPage": "https://api.pexels.com/videos/search?page=2&per_page=10&query=ocean",
  "prevPage": null
}
```

---

### 5. Get Popular Videos

Get trending/popular videos.

**Endpoint:** `GET /pexels/videos/popular`

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | number | No | Page number (default: 1) |
| `perPage` | number | No | Results per page (default: 15, max: 80) |
| `minWidth` | number | No | Minimum video width in pixels |
| `minHeight` | number | No | Minimum video height in pixels |
| `minDuration` | number | No | Minimum duration in seconds |
| `maxDuration` | number | No | Maximum duration in seconds |

**Example Request:**
```
GET /pexels/videos/popular?perPage=10&minDuration=5&maxDuration=30
```

**Example Response:**
```json
{
  "items": [
    {
      "id": 857251,
      "width": 1920,
      "height": 1080,
      "url": "https://www.pexels.com/video/...",
      "image": "https://images.pexels.com/videos/857251/free-video-857251.jpg",
      "duration": 15,
      "user": {
        "id": 2659,
        "name": "Pressmaster",
        "url": "https://www.pexels.com/@pressmaster"
      },
      "videoFiles": [...],
      "videoPictures": [...]
    }
  ],
  "totalResults": 10000,
  "page": 1,
  "perPage": 10,
  "nextPage": "...",
  "prevPage": null
}
```

---

### 6. Get Video by ID

Get a specific video by its ID.

**Endpoint:** `GET /pexels/videos/:id`

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Pexels video ID |

**Example Request:**
```
GET /pexels/videos/1093662
```

**Example Response:**
```json
{
  "id": 1093662,
  "width": 1920,
  "height": 1080,
  "url": "https://www.pexels.com/video/...",
  "image": "https://images.pexels.com/videos/1093662/free-video-1093662.jpg",
  "duration": 22,
  "user": {
    "id": 631997,
    "name": "Engin Akyurt",
    "url": "https://www.pexels.com/@enginakyurt"
  },
  "videoFiles": [
    {
      "id": 48035,
      "quality": "hd",
      "fileType": "video/mp4",
      "width": 1920,
      "height": 1080,
      "fps": 23.976,
      "link": "https://player.vimeo.com/external/..."
    }
  ],
  "videoPictures": [
    {
      "id": 134906,
      "picture": "https://images.pexels.com/videos/1093662/pictures/preview-0.jpg",
      "nr": 0
    }
  ]
}
```

---

## Usage Notes

### Photo Sizes

Use the appropriate `src` field based on your needs:

| Field | Use Case |
|-------|----------|
| `original` | Full resolution download |
| `large2x` | High-res display (retina) |
| `large` | Standard large display |
| `medium` | Medium display |
| `small` | Small thumbnails |
| `portrait` | Portrait crop (800x1200) |
| `landscape` | Landscape crop (1200x627) |
| `tiny` | Tiny preview (280x200) |

### Video Quality

Videos come with multiple quality options in `videoFiles`:

| Quality | Typical Resolution |
|---------|-------------------|
| `uhd` | 4K (3840x2160) |
| `hd` | 1080p (1920x1080) |
| `sd` | 540p (960x540) |

### Rate Limits

- **200 requests per hour**
- **20,000 requests per month**

### Attribution

While not required, Pexels appreciates attribution:
- Photographer name and link available in response
- Link to original Pexels page in `url` field

---

## Error Responses

**400 Bad Request:**
```json
{
  "statusCode": 400,
  "message": "Pexels API key not configured",
  "error": "Bad Request"
}
```

**404 Not Found:**
```json
{
  "statusCode": 400,
  "message": "Photo not found",
  "error": "Bad Request"
}
```

---

## Frontend Integration Example

### Searching and displaying photos:

```typescript
// Search for photos
const response = await fetch('/pexels/photos/search?query=technology&perPage=20', {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});
const data = await response.json();

// Use the medium size for display, original for download
data.items.forEach(photo => {
  console.log('Display:', photo.src.medium);
  console.log('Download:', photo.src.original);
  console.log('Photographer:', photo.photographer);
});
```

### Getting the best video quality:

```typescript
// Get video by ID
const response = await fetch('/pexels/videos/1093662', {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});
const video = await response.json();

// Find the HD quality video file
const hdVideo = video.videoFiles.find(f => f.quality === 'hd');
const videoUrl = hdVideo?.link || video.videoFiles[0].link;

console.log('Video URL:', videoUrl);
console.log('Thumbnail:', video.image);
console.log('Duration:', video.duration, 'seconds');
```
