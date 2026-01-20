# Cloud Storage Integrations Guide

This document covers the OneDrive and Dropbox integrations for accessing media files from cloud storage services.

## Table of Contents
- [Overview](#overview)
- [OneDrive Integration](#onedrive-integration)
- [Dropbox Integration](#dropbox-integration)
- [Frontend Integration Example](#frontend-integration-example)

---

## Overview

Cloud storage integrations allow users to access their media files (images and videos) stored in OneDrive and Dropbox directly from the social media manager. This makes it easy to use existing media files when creating posts.

### Supported Operations
- List files and folders
- Browse folder hierarchy
- Filter by media type (images/videos)
- Search files
- Get download URLs

---

## OneDrive Integration

### Setup

#### 1. Create Microsoft Azure AD App

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to **Azure Active Directory** → **App registrations**
3. Click **New registration**
4. Configure:
   - Name: `Your App Name`
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
   - Redirect URI: `https://your-backend.com/channels/oauth/onedrive/callback`
5. Click **Register**

#### 2. Configure API Permissions

In your app registration:
1. Go to **API permissions**
2. Click **Add a permission** → **Microsoft Graph**
3. Select **Delegated permissions**
4. Add:
   - `Files.Read`
   - `Files.Read.All`
   - `User.Read`
   - `offline_access` (for refresh tokens)

#### 3. Create Client Secret

1. Go to **Certificates & secrets**
2. Click **New client secret**
3. Copy the secret value immediately (it won't be shown again)

#### 4. Environment Variables

```env
ONEDRIVE_CLIENT_ID=your-azure-app-client-id
ONEDRIVE_CLIENT_SECRET=your-azure-app-client-secret
```

### OAuth Flow

#### Initiate OAuth
```
POST /channels/workspaces/{workspaceId}/oauth/initiate
```

**Body:**
```json
{
  "platform": "onedrive",
  "redirectUrl": "https://yourfrontend.com/settings"
}
```

**Response:**
```json
{
  "authorizationUrl": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?...",
  "state": "random-state-token",
  "expiresAt": "2024-01-15T11:00:00Z"
}
```

#### Callback URLs to Register
Add these redirect URIs in Azure Portal:
- Production: `https://your-backend.com/channels/oauth/onedrive/callback`
- Development: `http://localhost:3001/channels/oauth/onedrive/callback`

### API Endpoints

#### Connect OneDrive
```
POST /channels/workspaces/{workspaceId}/onedrive/connect
```

**Body:**
```json
{
  "accessToken": "EwB4A...",
  "refreshToken": "M.R3_...",
  "tokenExpiresAt": "2024-01-15T11:00:00Z"
}
```

**Response:**
```json
{
  "channel": {
    "id": 123,
    "platform": "onedrive",
    "accountName": "John Doe",
    "username": "john@outlook.com",
    "connectionStatus": "connected"
  },
  "message": "OneDrive connected successfully"
}
```

#### Get User Info
```
POST /channels/onedrive/me
```

**Body:**
```json
{
  "accessToken": "EwB4A..."
}
```

**Response:**
```json
{
  "id": "drive-id-123",
  "driveType": "personal",
  "owner": {
    "user": {
      "displayName": "John Doe",
      "email": "john@outlook.com"
    }
  },
  "quota": {
    "total": 5368709120,
    "used": 1234567890,
    "remaining": 4134141230
  }
}
```

#### List Media Files (Images & Videos)
```
POST /channels/onedrive/media
```

**Body:**
```json
{
  "accessToken": "EwB4A...",
  "folderId": "optional-folder-id",
  "pageSize": 20,
  "nextLink": "optional-pagination-url"
}
```

**Response:**
```json
{
  "items": [
    {
      "id": "item-id-123",
      "name": "photo.jpg",
      "size": 1234567,
      "createdDateTime": "2024-01-15T10:30:00Z",
      "lastModifiedDateTime": "2024-01-15T10:30:00Z",
      "webUrl": "https://onedrive.live.com/...",
      "file": {
        "mimeType": "image/jpeg"
      },
      "image": {
        "width": 4032,
        "height": 3024
      },
      "thumbnails": [
        {
          "small": { "url": "https://...", "width": 96, "height": 72 },
          "medium": { "url": "https://...", "width": 176, "height": 132 },
          "large": { "url": "https://...", "width": 800, "height": 600 }
        }
      ],
      "@microsoft.graph.downloadUrl": "https://..."
    }
  ],
  "nextLink": "https://graph.microsoft.com/v1.0/me/drive/items/...?$skiptoken=..."
}
```

#### List Images Only
```
POST /channels/onedrive/images
```
Same body/response as `/media`

#### List Videos Only
```
POST /channels/onedrive/videos
```
Same body/response as `/media`

#### List Folders
```
POST /channels/onedrive/folders
```

**Body:**
```json
{
  "accessToken": "EwB4A...",
  "parentId": "optional-parent-folder-id",
  "pageSize": 50,
  "nextLink": "optional"
}
```

**Response:**
```json
{
  "items": [
    {
      "id": "folder-id-123",
      "name": "My Photos",
      "folder": {
        "childCount": 42
      },
      "createdDateTime": "2024-01-10T08:00:00Z"
    }
  ],
  "nextLink": null
}
```

#### Search Files
```
POST /channels/onedrive/search
```

**Body:**
```json
{
  "accessToken": "EwB4A...",
  "query": "vacation",
  "pageSize": 20,
  "nextLink": "optional"
}
```

#### Get Specific Item
```
POST /channels/onedrive/item/{itemId}
```

**Body:**
```json
{
  "accessToken": "EwB4A..."
}
```

#### Get Download URL
```
POST /channels/onedrive/download-url/{itemId}
```

**Body:**
```json
{
  "accessToken": "EwB4A..."
}
```

**Response:**
```json
{
  "downloadUrl": "https://..."
}
```

#### Verify Access
```
POST /channels/onedrive/verify
```

**Body:**
```json
{
  "accessToken": "EwB4A..."
}
```

**Response:**
```json
{
  "hasAccess": true
}
```

---

## Dropbox Integration

### Setup

#### 1. Create Dropbox App

1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Click **Create app**
3. Configure:
   - API: **Scoped access**
   - Access type: **Full Dropbox** (or App folder if you prefer limited access)
   - Name: `Your App Name`
4. Click **Create app**

#### 2. Configure Permissions

In the **Permissions** tab, enable:
- `account_info.read`
- `files.metadata.read`
- `files.content.read`

Click **Submit** to save.

#### 3. Configure OAuth

In the **Settings** tab:
1. Add redirect URIs:
   - Production: `https://your-backend.com/channels/oauth/dropbox/callback`
   - Development: `http://localhost:3001/channels/oauth/dropbox/callback`
2. Note your **App key** (client ID) and **App secret** (client secret)

#### 4. Environment Variables

```env
DROPBOX_CLIENT_ID=your-dropbox-app-key
DROPBOX_CLIENT_SECRET=your-dropbox-app-secret
```

### OAuth Flow

#### Initiate OAuth
```
POST /channels/workspaces/{workspaceId}/oauth/initiate
```

**Body:**
```json
{
  "platform": "dropbox",
  "redirectUrl": "https://yourfrontend.com/settings"
}
```

**Response:**
```json
{
  "authorizationUrl": "https://www.dropbox.com/oauth2/authorize?...",
  "state": "random-state-token",
  "expiresAt": "2024-01-15T11:00:00Z"
}
```

### API Endpoints

#### Connect Dropbox
```
POST /channels/workspaces/{workspaceId}/dropbox/connect
```

**Body:**
```json
{
  "accessToken": "sl.B...",
  "refreshToken": "refresh-token...",
  "tokenExpiresAt": "2024-01-15T15:00:00Z"
}
```

**Response:**
```json
{
  "channel": {
    "id": 124,
    "platform": "dropbox",
    "accountName": "John Doe",
    "username": "john@example.com",
    "profilePictureUrl": "https://...",
    "connectionStatus": "connected"
  },
  "message": "Dropbox connected successfully"
}
```

#### Get User Info
```
POST /channels/dropbox/me
```

**Body:**
```json
{
  "accessToken": "sl.B..."
}
```

**Response:**
```json
{
  "account_id": "dbid:AAB...",
  "name": {
    "given_name": "John",
    "surname": "Doe",
    "familiar_name": "John",
    "display_name": "John Doe"
  },
  "email": "john@example.com",
  "email_verified": true,
  "profile_photo_url": "https://...",
  "country": "US"
}
```

#### Get Space Usage
```
POST /channels/dropbox/space
```

**Body:**
```json
{
  "accessToken": "sl.B..."
}
```

**Response:**
```json
{
  "used": 1234567890,
  "allocation": {
    ".tag": "individual",
    "allocated": 2147483648
  }
}
```

#### List Files and Folders
```
POST /channels/dropbox/list
```

**Body:**
```json
{
  "accessToken": "sl.B...",
  "path": "",
  "limit": 20,
  "cursor": "optional-for-pagination",
  "recursive": false
}
```

**Note:** Use empty string `""` or `"/"` for root folder.

**Response:**
```json
{
  "entries": [
    {
      ".tag": "file",
      "id": "id:abc123",
      "name": "photo.jpg",
      "path_lower": "/photo.jpg",
      "path_display": "/Photo.jpg",
      "size": 1234567,
      "is_downloadable": true,
      "client_modified": "2024-01-15T10:30:00Z",
      "server_modified": "2024-01-15T10:31:00Z",
      "media_info": {
        ".tag": "metadata",
        "metadata": {
          ".tag": "photo",
          "dimensions": {
            "width": 4032,
            "height": 3024
          },
          "time_taken": "2024-01-15T10:00:00Z"
        }
      }
    },
    {
      ".tag": "folder",
      "id": "id:xyz789",
      "name": "Photos",
      "path_lower": "/photos",
      "path_display": "/Photos"
    }
  ],
  "cursor": "cursor-for-next-page...",
  "has_more": true
}
```

#### List Media Files (Images & Videos)
```
POST /channels/dropbox/media
```

**Body:**
```json
{
  "accessToken": "sl.B...",
  "path": "",
  "limit": 20,
  "cursor": "optional"
}
```

#### List Images Only
```
POST /channels/dropbox/images
```
Same body/response as `/media`

#### List Videos Only
```
POST /channels/dropbox/videos
```
Same body/response as `/media`

#### List Folders Only
```
POST /channels/dropbox/folders
```

**Body:**
```json
{
  "accessToken": "sl.B...",
  "path": "",
  "limit": 50,
  "cursor": "optional"
}
```

#### Search Files
```
POST /channels/dropbox/search
```

**Body:**
```json
{
  "accessToken": "sl.B...",
  "query": "vacation",
  "path": "",
  "maxResults": 20,
  "cursor": "optional",
  "fileExtensions": ["jpg", "png", "mp4"]
}
```

**Response:**
```json
{
  "matches": [
    {
      ".tag": "file",
      "id": "id:abc123",
      "name": "vacation_photo.jpg",
      "path_lower": "/vacation_photo.jpg",
      "path_display": "/vacation_photo.jpg",
      "size": 2345678
    }
  ],
  "cursor": "cursor-for-more...",
  "has_more": false
}
```

#### Get File Metadata
```
POST /channels/dropbox/metadata
```

**Body:**
```json
{
  "accessToken": "sl.B...",
  "path": "/photo.jpg"
}
```

#### Get Temporary Download Link
```
POST /channels/dropbox/download-link
```

**Body:**
```json
{
  "accessToken": "sl.B...",
  "path": "/photo.jpg"
}
```

**Response:**
```json
{
  "downloadLink": "https://dl.dropboxusercontent.com/..."
}
```

**Note:** Temporary links expire after 4 hours.

#### Verify Access
```
POST /channels/dropbox/verify
```

**Body:**
```json
{
  "accessToken": "sl.B..."
}
```

**Response:**
```json
{
  "hasAccess": true
}
```

---

## Frontend Integration Example

### 1. Connect Cloud Storage

```typescript
// Connect OneDrive
const connectOneDrive = async (workspaceId: string) => {
  const response = await fetch(`/channels/workspaces/${workspaceId}/oauth/initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userJwtToken}`
    },
    body: JSON.stringify({
      platform: 'onedrive',
      redirectUrl: `${window.location.origin}/settings`
    })
  });

  const { authorizationUrl } = await response.json();
  window.location.href = authorizationUrl;
};

// Connect Dropbox
const connectDropbox = async (workspaceId: string) => {
  const response = await fetch(`/channels/workspaces/${workspaceId}/oauth/initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userJwtToken}`
    },
    body: JSON.stringify({
      platform: 'dropbox',
      redirectUrl: `${window.location.origin}/settings`
    })
  });

  const { authorizationUrl } = await response.json();
  window.location.href = authorizationUrl;
};
```

### 2. Handle OAuth Callback

```typescript
// After OAuth redirect, extract tokens and complete connection
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const accessToken = params.get('accessToken');
  const refreshToken = params.get('refreshToken');
  const expiresAt = params.get('expiresAt');
  const platform = params.get('platform');

  if (accessToken && platform) {
    completeConnection(platform, accessToken, refreshToken, expiresAt);
    window.history.replaceState({}, '', '/settings');
  }
}, []);

const completeConnection = async (
  platform: 'onedrive' | 'dropbox',
  accessToken: string,
  refreshToken: string | null,
  expiresAt: string | null
) => {
  await fetch(`/channels/workspaces/${workspaceId}/${platform}/connect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userJwtToken}`
    },
    body: JSON.stringify({
      accessToken,
      refreshToken,
      tokenExpiresAt: expiresAt
    })
  });
};
```

### 3. Media Picker Component

```typescript
interface CloudFile {
  id: string;
  name: string;
  size: number;
  thumbnailUrl?: string;
  downloadUrl?: string;
  mimeType?: string;
}

const MediaPicker: React.FC<{
  platform: 'onedrive' | 'dropbox';
  accessToken: string;
  onSelect: (file: CloudFile) => void;
}> = ({ platform, accessToken, onSelect }) => {
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [loading, setLoading] = useState(false);

  const loadMedia = async (folderId?: string) => {
    setLoading(true);

    const endpoint = platform === 'onedrive'
      ? '/channels/onedrive/media'
      : '/channels/dropbox/media';

    const body = platform === 'onedrive'
      ? { accessToken, folderId }
      : { accessToken, path: currentPath };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userJwtToken}`
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    // Normalize response format
    const normalized = platform === 'onedrive'
      ? data.items.map(item => ({
          id: item.id,
          name: item.name,
          size: item.size,
          thumbnailUrl: item.thumbnails?.[0]?.medium?.url,
          downloadUrl: item['@microsoft.graph.downloadUrl'],
          mimeType: item.file?.mimeType
        }))
      : data.entries.map(entry => ({
          id: entry.id,
          name: entry.name,
          size: entry.size,
          mimeType: entry['.tag'] === 'file' ? 'image/jpeg' : undefined // Get from extension
        }));

    setFiles(normalized);
    setLoading(false);
  };

  useEffect(() => {
    loadMedia();
  }, [currentPath]);

  return (
    <div className="media-picker">
      {loading ? (
        <div>Loading...</div>
      ) : (
        <div className="file-grid">
          {files.map(file => (
            <div
              key={file.id}
              className="file-item"
              onClick={() => onSelect(file)}
            >
              {file.thumbnailUrl && (
                <img src={file.thumbnailUrl} alt={file.name} />
              )}
              <span>{file.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
```

### 4. Download File for Upload

```typescript
// Get download URL and use it for post upload
const useCloudFile = async (
  platform: 'onedrive' | 'dropbox',
  fileIdOrPath: string,
  accessToken: string
) => {
  let downloadUrl: string;

  if (platform === 'onedrive') {
    const response = await fetch(`/channels/onedrive/download-url/${fileIdOrPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken })
    });
    const data = await response.json();
    downloadUrl = data.downloadUrl;
  } else {
    const response = await fetch('/channels/dropbox/download-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken, path: fileIdOrPath })
    });
    const data = await response.json();
    downloadUrl = data.downloadLink;
  }

  return downloadUrl;
};
```

---

## Error Handling

All endpoints return standard error responses:

```json
{
  "statusCode": 400,
  "message": "Failed to list OneDrive items",
  "error": "Bad Request"
}
```

**Common errors:**
- `401` - Access token expired (use refresh token)
- `403` - Insufficient permissions
- `404` - File/folder not found
- `429` - Rate limit exceeded

---

## Token Management

### OneDrive (Microsoft Graph)
- Access tokens expire after **1 hour**
- Refresh tokens expire after **90 days of inactivity**
- Use `offline_access` scope for refresh tokens

### Dropbox
- Short-lived access tokens (configurable, default 4 hours)
- Use `token_access_type=offline` for refresh tokens
- Refresh tokens don't expire unless revoked

### Refresh Token Example

```typescript
const refreshToken = async (platform: 'onedrive' | 'dropbox', refreshToken: string) => {
  const response = await fetch('/channels/oauth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, refreshToken })
  });

  const { accessToken, newRefreshToken, expiresIn } = await response.json();

  // Store new tokens
  return { accessToken, refreshToken: newRefreshToken || refreshToken, expiresIn };
};
```
