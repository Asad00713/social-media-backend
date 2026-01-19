# Google Integrations Guide

This document covers the Google Drive, Google Photos, and Google Calendar integrations. All three services use the **same Google OAuth app** as YouTube but with different scopes (incremental authorization).

## Table of Contents
- [Setup](#setup)
- [OAuth Flow](#oauth-flow)
- [Google Drive API](#google-drive-api)
- [Google Photos API](#google-photos-api)
- [Google Calendar API](#google-calendar-api)

---

## Setup

### 1. Enable APIs in Google Cloud Console

Go to [Google Cloud Console](https://console.cloud.google.com/apis/library) and enable:

1. **Google Drive API** - For accessing user's Drive files
2. **Photos Library API** - For accessing user's Google Photos
3. **Google Calendar API** - For calendar sync

### 2. Add Scopes to OAuth Consent Screen

In Google Cloud Console → APIs & Services → OAuth consent screen → Edit App → Scopes:

| Service | Scope | Purpose |
|---------|-------|---------|
| Google Drive | `https://www.googleapis.com/auth/drive.readonly` | Read files from Drive |
| Google Photos | `https://www.googleapis.com/auth/photoslibrary.readonly` | Read photos and videos |
| Google Calendar | `https://www.googleapis.com/auth/calendar.events` | Create/update/delete events |
| Google Calendar | `https://www.googleapis.com/auth/calendar.readonly` | Read calendar list |

### 3. Environment Variables

All Google services use the same credentials as YouTube:

```env
YOUTUBE_CLIENT_ID=your-google-client-id
YOUTUBE_CLIENT_SECRET=your-google-client-secret
```

---

## OAuth Flow

Each Google service has its own OAuth flow with specific scopes. This allows users to grant permissions incrementally (only when they need each feature).

### Initiate OAuth

```
GET /channels/oauth/{platform}/initiate
```

**Platforms:**
- `google_drive` - For Drive access
- `google_photos` - For Photos access
- `google_calendar` - For Calendar access

**Query Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | Yes | Workspace ID |
| `redirectUrl` | No | Frontend URL to redirect after OAuth (defaults to FRONTEND_URL) |

**Example:**
```
GET /channels/oauth/google_drive/initiate?workspaceId=abc123&redirectUrl=https://myapp.com/settings
```

**Response:**
```json
{
  "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&scope=https://www.googleapis.com/auth/drive.readonly&..."
}
```

### OAuth Callback

After user authorizes, they're redirected to:
```
GET /channels/oauth/{platform}/callback?code=...&state=...
```

This exchanges the code for tokens and redirects to your frontend:
```
{redirectUrl}/channels/connect/success?accessToken=...&refreshToken=...&expiresIn=...
```

### Refresh Token

```
POST /channels/oauth/refresh
```

**Body:**
```json
{
  "platform": "google_drive",
  "refreshToken": "your-refresh-token"
}
```

---

## Google Drive API

Access user's files from Google Drive to use as media in posts.

### Base URL
All endpoints: `POST /channels/google-drive/...`

### Endpoints

#### List Media Files (Images & Videos)
```
POST /channels/google-drive/media
```

**Body:**
```json
{
  "accessToken": "ya29...",
  "folderId": "optional-folder-id",
  "query": "optional search term",
  "pageSize": 20,
  "pageToken": "optional-for-pagination"
}
```

**Response:**
```json
{
  "files": [
    {
      "id": "1abc123...",
      "name": "photo.jpg",
      "mimeType": "image/jpeg",
      "thumbnailLink": "https://...",
      "webContentLink": "https://...",
      "webViewLink": "https://...",
      "size": "1234567",
      "createdTime": "2024-01-15T10:30:00Z",
      "modifiedTime": "2024-01-15T10:30:00Z"
    }
  ],
  "nextPageToken": "token-for-next-page"
}
```

#### List Images Only
```
POST /channels/google-drive/images
```
Same body/response as `/media`

#### List Videos Only
```
POST /channels/google-drive/videos
```
Same body/response as `/media`

#### List Folders
```
POST /channels/google-drive/folders
```

**Body:**
```json
{
  "accessToken": "ya29...",
  "parentId": "optional-parent-folder-id",
  "pageSize": 50,
  "pageToken": "optional"
}
```

**Response:**
```json
{
  "folders": [
    {
      "id": "1xyz...",
      "name": "My Photos"
    }
  ],
  "nextPageToken": "..."
}
```

#### Get Specific File
```
POST /channels/google-drive/file/{fileId}
```

**Body:**
```json
{
  "accessToken": "ya29..."
}
```

#### Get User Info
```
POST /channels/google-drive/me
```

**Body:**
```json
{
  "accessToken": "ya29..."
}
```

**Response:**
```json
{
  "email": "user@gmail.com",
  "displayName": "John Doe",
  "photoLink": "https://..."
}
```

#### Verify Access
```
POST /channels/google-drive/verify
```

**Body:**
```json
{
  "accessToken": "ya29..."
}
```

**Response:**
```json
{
  "hasAccess": true
}
```

---

## Google Photos API

Access user's photos and videos from Google Photos.

### Base URL
All endpoints: `POST /channels/google-photos/...`

### Endpoints

#### List All Media
```
POST /channels/google-photos/media
```

**Body:**
```json
{
  "accessToken": "ya29...",
  "pageSize": 25,
  "pageToken": "optional",
  "albumId": "optional-album-id",
  "mediaType": "ALL_MEDIA"
}
```

**mediaType options:** `ALL_MEDIA`, `PHOTO`, `VIDEO`

**Response:**
```json
{
  "mediaItems": [
    {
      "id": "abc123...",
      "productUrl": "https://photos.google.com/...",
      "baseUrl": "https://lh3.googleusercontent.com/...",
      "mimeType": "image/jpeg",
      "filename": "IMG_1234.jpg",
      "mediaMetadata": {
        "creationTime": "2024-01-15T10:30:00Z",
        "width": "4032",
        "height": "3024",
        "photo": {
          "cameraMake": "Apple",
          "cameraModel": "iPhone 14 Pro"
        }
      }
    }
  ],
  "nextPageToken": "..."
}
```

#### List Photos Only
```
POST /channels/google-photos/photos
```

#### List Videos Only
```
POST /channels/google-photos/videos
```

#### List Albums
```
POST /channels/google-photos/albums
```

**Body:**
```json
{
  "accessToken": "ya29...",
  "pageSize": 50,
  "pageToken": "optional"
}
```

**Response:**
```json
{
  "albums": [
    {
      "id": "album123...",
      "title": "Vacation 2024",
      "productUrl": "https://photos.google.com/...",
      "mediaItemsCount": "42",
      "coverPhotoBaseUrl": "https://..."
    }
  ],
  "nextPageToken": "..."
}
```

#### Get Specific Media Item
```
POST /channels/google-photos/media/{mediaItemId}
```

#### Verify Access
```
POST /channels/google-photos/verify
```

### Downloading Photos

The `baseUrl` in the response is a base URL. Append parameters to download:

| Suffix | Result |
|--------|--------|
| `=d` | Original quality download (photos) |
| `=dv` | Download video |
| `=w{width}-h{height}` | Specific dimensions |
| `=w800-h600` | 800x600 pixels |

**Example:**
```
https://lh3.googleusercontent.com/abc123=w1080-h1080
```

---

## Google Calendar API

Sync scheduled posts to user's Google Calendar.

### Base URL
All endpoints: `POST /channels/google-calendar/...`

### Endpoints

#### List Calendars
```
POST /channels/google-calendar/calendars
```

**Body:**
```json
{
  "accessToken": "ya29..."
}
```

**Response:**
```json
[
  {
    "id": "primary",
    "summary": "john@gmail.com",
    "primary": true,
    "backgroundColor": "#4285f4"
  },
  {
    "id": "abc123@group.calendar.google.com",
    "summary": "Work Calendar",
    "primary": false
  }
]
```

#### Get Primary Calendar
```
POST /channels/google-calendar/primary
```

#### List Events
```
POST /channels/google-calendar/events
```

**Body:**
```json
{
  "accessToken": "ya29...",
  "calendarId": "primary",
  "timeMin": "2024-01-01T00:00:00Z",
  "timeMax": "2024-01-31T23:59:59Z",
  "maxResults": 50,
  "pageToken": "optional"
}
```

**Response:**
```json
{
  "events": [
    {
      "id": "event123",
      "summary": "📘📸 Check out our new product launch...",
      "description": "📝 Caption:\nCheck out our new product...\n\n📱 Platforms: facebook, instagram",
      "start": {
        "dateTime": "2024-01-15T10:00:00Z",
        "timeZone": "UTC"
      },
      "end": {
        "dateTime": "2024-01-15T10:30:00Z",
        "timeZone": "UTC"
      },
      "colorId": "9",
      "htmlLink": "https://calendar.google.com/..."
    }
  ],
  "nextPageToken": "..."
}
```

#### Create Generic Event
```
POST /channels/google-calendar/events/create
```

**Body:**
```json
{
  "accessToken": "ya29...",
  "summary": "My Event",
  "description": "Event description",
  "startTime": "2024-01-15T10:00:00Z",
  "endTime": "2024-01-15T11:00:00Z",
  "timeZone": "America/New_York",
  "colorId": "9",
  "calendarId": "primary"
}
```

#### Create Event for Scheduled Post ⭐
```
POST /channels/google-calendar/events/post
```

This is the main endpoint for syncing scheduled posts to calendar.

**Body:**
```json
{
  "accessToken": "ya29...",
  "postId": "post-uuid-123",
  "platforms": ["facebook", "instagram", "twitter"],
  "caption": "Check out our amazing new product! 🚀 #launch #newproduct",
  "scheduledAt": "2024-01-15T10:00:00Z",
  "mediaUrls": ["https://example.com/image1.jpg"],
  "workspaceName": "My Brand",
  "calendarId": "primary"
}
```

**Response:**
```json
{
  "id": "event123abc",
  "summary": "📘📸🐦 Check out our amazing new product! 🚀...",
  "description": "📝 Caption:\nCheck out our amazing new product! 🚀 #launch #newproduct\n\n📱 Platforms: facebook, instagram, twitter\n\n🏢 Workspace: My Brand\n\n🖼️ Media: 1 file(s)\n\n🔗 Post ID: post-uuid-123\n\n---\nManaged by Social Media Manager",
  "start": {
    "dateTime": "2024-01-15T10:00:00.000Z",
    "timeZone": "UTC"
  },
  "colorId": "9",
  "htmlLink": "https://calendar.google.com/calendar/event?eid=..."
}
```

**Platform Emojis:**
| Platform | Emoji |
|----------|-------|
| Facebook | 📘 |
| Instagram | 📸 |
| Twitter | 🐦 |
| LinkedIn | 💼 |
| YouTube | ▶️ |
| TikTok | 🎵 |
| Pinterest | 📌 |
| Threads | 🧵 |

**Event Colors:**
| Platform | Color ID | Color |
|----------|----------|-------|
| Facebook | 9 | Blue |
| Instagram | 6 | Orange |
| Twitter | 7 | Cyan |
| LinkedIn | 1 | Blue |
| YouTube | 11 | Red |
| TikTok | 2 | Green |
| Pinterest | 4 | Pink |
| Threads | 8 | Gray |

#### Get Event
```
POST /channels/google-calendar/events/{eventId}
```

**Body:**
```json
{
  "accessToken": "ya29...",
  "calendarId": "primary"
}
```

#### Update Event
```
POST /channels/google-calendar/events/{eventId}/update
```

**Body:**
```json
{
  "accessToken": "ya29...",
  "summary": "Updated title",
  "startTime": "2024-01-15T14:00:00Z",
  "calendarId": "primary"
}
```

#### Delete Event
```
POST /channels/google-calendar/events/{eventId}/delete
```

**Body:**
```json
{
  "accessToken": "ya29...",
  "calendarId": "primary"
}
```

**Response:**
```json
{
  "success": true
}
```

#### Mark Event as Published ✅
```
POST /channels/google-calendar/events/{eventId}/published
```

Adds ✅ prefix to event title to indicate the post was published successfully.

**Body:**
```json
{
  "accessToken": "ya29...",
  "calendarId": "primary"
}
```

**Result:** Event title changes from `📘📸 Caption...` to `✅ 📘📸 Caption...`

#### Mark Event as Failed ❌
```
POST /channels/google-calendar/events/{eventId}/failed
```

Adds ❌ prefix to event title to indicate the post failed to publish.

**Body:**
```json
{
  "accessToken": "ya29...",
  "calendarId": "primary"
}
```

**Result:** Event title changes from `📘📸 Caption...` to `❌ 📘📸 Caption...`

#### Verify Access
```
POST /channels/google-calendar/verify
```

---

## Frontend Integration Example

### 1. Connect Google Services

```typescript
// When user clicks "Connect Google Drive"
const connectGoogleDrive = async (workspaceId: string) => {
  const response = await fetch(
    `/channels/oauth/google_drive/initiate?workspaceId=${workspaceId}&redirectUrl=${window.location.origin}/settings`
  );
  const { authorizationUrl } = await response.json();
  window.location.href = authorizationUrl;
};

// Similar for Photos and Calendar
const connectGooglePhotos = (workspaceId) => { /* ... */ };
const connectGoogleCalendar = (workspaceId) => { /* ... */ };
```

### 2. Handle OAuth Callback

```typescript
// On /settings page, check for OAuth success
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const accessToken = params.get('accessToken');
  const refreshToken = params.get('refreshToken');

  if (accessToken) {
    // Store tokens securely
    saveGoogleTokens({ accessToken, refreshToken });
    // Clean URL
    window.history.replaceState({}, '', '/settings');
  }
}, []);
```

### 3. Sync Post to Calendar

```typescript
const syncPostToCalendar = async (post: ScheduledPost, calendarAccessToken: string) => {
  const response = await fetch('/channels/google-calendar/events/post', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userJwtToken}`
    },
    body: JSON.stringify({
      accessToken: calendarAccessToken,
      postId: post.id,
      platforms: post.platforms,
      caption: post.caption,
      scheduledAt: post.scheduledAt,
      mediaUrls: post.mediaUrls,
      workspaceName: post.workspace.name
    })
  });

  const calendarEvent = await response.json();
  // Store calendarEvent.id with the post for future updates
  return calendarEvent;
};
```

### 4. Update Calendar When Post Status Changes

```typescript
// When post is published
const markPostPublished = async (eventId: string, calendarAccessToken: string) => {
  await fetch(`/channels/google-calendar/events/${eventId}/published`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: calendarAccessToken })
  });
};

// When post fails
const markPostFailed = async (eventId: string, calendarAccessToken: string) => {
  await fetch(`/channels/google-calendar/events/${eventId}/failed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: calendarAccessToken })
  });
};

// When post is rescheduled
const updatePostSchedule = async (eventId: string, newTime: Date, calendarAccessToken: string) => {
  await fetch(`/channels/google-calendar/events/${eventId}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessToken: calendarAccessToken,
      startTime: newTime.toISOString()
    })
  });
};

// When post is deleted
const deletePostEvent = async (eventId: string, calendarAccessToken: string) => {
  await fetch(`/channels/google-calendar/events/${eventId}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: calendarAccessToken })
  });
};
```

---

## Error Handling

All endpoints return standard error responses:

```json
{
  "statusCode": 400,
  "message": "Failed to list Google Drive files",
  "error": "Bad Request"
}
```

**Common errors:**
- `401` - Access token expired (use refresh token)
- `403` - Insufficient permissions (user needs to re-authorize with required scopes)
- `404` - Resource not found (file, event, etc.)
- `429` - Rate limit exceeded

---

## Token Management

Google access tokens expire after 1 hour. Store and manage refresh tokens:

1. **Store refresh token** when user first authorizes
2. **Check token validity** before API calls
3. **Refresh when expired** using `/channels/oauth/refresh`
4. **Handle re-authorization** if refresh fails (token revoked)

```typescript
const ensureValidToken = async (platform: string, tokens: GoogleTokens) => {
  // Check if token is expired (with 5 min buffer)
  const expiresAt = tokens.expiresAt - 5 * 60 * 1000;

  if (Date.now() > expiresAt) {
    const response = await fetch('/channels/oauth/refresh', {
      method: 'POST',
      body: JSON.stringify({
        platform,
        refreshToken: tokens.refreshToken
      })
    });

    const newTokens = await response.json();
    // Update stored tokens
    return newTokens.accessToken;
  }

  return tokens.accessToken;
};
```
