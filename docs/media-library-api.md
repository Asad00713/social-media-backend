# Media Library API Documentation

Base URL: `/workspaces/:workspaceId/media-library`

All endpoints require JWT authentication via the `Authorization: Bearer <token>` header.

---

## Table of Contents

1. [Categories](#categories)
2. [Media Items](#media-items-images-videos-gifs-documents)
3. [Templates](#templates)
4. [Text Snippets](#text-snippets)
5. [Saved Links](#saved-links)
6. [Recycle Bin](#recycle-bin)

---

## Categories

Categories are used to organize items within each type. Each category belongs to a specific type (image, video, gif, document, template, text_snippet, link).

### Create Category

```
POST /workspaces/:workspaceId/media-library/categories
```

**Request Body:**

```json
{
  "name": "Marketing Images",
  "description": "Images for marketing campaigns",
  "type": "image",
  "color": "#FF5733",
  "icon": "folder"
}
```

| Field       | Type   | Required | Description                                                                            |
| ----------- | ------ | -------- | -------------------------------------------------------------------------------------- |
| name        | string | Yes      | Category name (max 100 chars)                                                          |
| description | string | No       | Category description                                                                   |
| type        | enum   | Yes      | One of: `image`, `video`, `gif`, `document`, `template`, `text_snippet`, `link`        |
| color       | string | No       | Color code (max 20 chars)                                                              |
| icon        | string | No       | Icon identifier (max 50 chars)                                                         |

**Response:** `201 Created`

```json
{
  "id": "uuid",
  "workspaceId": "uuid",
  "name": "Marketing Images",
  "description": "Images for marketing campaigns",
  "type": "image",
  "color": "#FF5733",
  "icon": "folder",
  "displayOrder": 0,
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

---

### Get All Categories

```
GET /workspaces/:workspaceId/media-library/categories
```

**Query Parameters:**

| Parameter | Type | Required | Description                                                                     |
| --------- | ---- | -------- | ------------------------------------------------------------------------------- |
| type      | enum | No       | Filter by type: `image`, `video`, `gif`, `document`, `template`, `text_snippet`, `link` |

**Response:** `200 OK`

```json
[
  {
    "id": "uuid",
    "workspaceId": "uuid",
    "name": "Marketing Images",
    "type": "image",
    "color": "#FF5733",
    "displayOrder": 0,
    "createdAt": "2024-01-15T10:30:00Z"
  }
]
```

---

### Get Categories Grouped by Type

```
GET /workspaces/:workspaceId/media-library/categories/grouped
```

**Response:** `200 OK`

```json
{
  "image": [
    { "id": "uuid", "name": "Marketing Images", "displayOrder": 0 }
  ],
  "video": [
    { "id": "uuid", "name": "Product Videos", "displayOrder": 0 }
  ],
  "template": [],
  "text_snippet": [],
  "link": []
}
```

---

### Get Single Category

```
GET /workspaces/:workspaceId/media-library/categories/:categoryId
```

**Response:** `200 OK`

---

### Update Category

```
PUT /workspaces/:workspaceId/media-library/categories/:categoryId
```

**Request Body:**

```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "color": "#00FF00",
  "icon": "star",
  "displayOrder": 1
}
```

All fields are optional.

**Response:** `200 OK`

---

### Delete Category

```
DELETE /workspaces/:workspaceId/media-library/categories/:categoryId
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Category deleted successfully"
}
```

---

### Reorder Categories

```
POST /workspaces/:workspaceId/media-library/categories/reorder
```

**Request Body:**

```json
{
  "type": "image",
  "categoryIds": ["uuid-1", "uuid-2", "uuid-3"]
}
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Categories reordered successfully"
}
```

---

## Media Items (Images, Videos, GIFs, Documents)

### Create Media Item

```
POST /workspaces/:workspaceId/media-library/items
```

**Request Body:**

```json
{
  "type": "image",
  "name": "Product Banner",
  "description": "Banner for summer campaign",
  "fileUrl": "https://res.cloudinary.com/...",
  "thumbnailUrl": "https://res.cloudinary.com/.../thumb",
  "mimeType": "image/png",
  "fileSize": 245000,
  "width": 1200,
  "height": 628,
  "cloudinaryPublicId": "workspace123/media/abc123",
  "cloudinaryAssetId": "abc123xyz",
  "categoryId": "uuid",
  "tags": ["summer", "banner", "campaign"]
}
```

| Field              | Type     | Required | Description                                   |
| ------------------ | -------- | -------- | --------------------------------------------- |
| type               | enum     | Yes      | One of: `image`, `video`, `gif`, `document`   |
| name               | string   | Yes      | Item name (max 255 chars)                     |
| description        | string   | No       | Item description                              |
| fileUrl            | string   | Yes      | URL to the file                               |
| thumbnailUrl       | string   | No       | URL to thumbnail                              |
| mimeType           | string   | No       | MIME type (max 100 chars)                     |
| fileSize           | integer  | No       | File size in bytes                            |
| width              | integer  | No       | Width in pixels                               |
| height             | integer  | No       | Height in pixels                              |
| duration           | integer  | No       | Duration in seconds (for video/gif)           |
| cloudinaryPublicId | string   | No       | Cloudinary public ID                          |
| cloudinaryAssetId  | string   | No       | Cloudinary asset ID                           |
| categoryId         | uuid     | No       | Category to assign                            |
| tags               | string[] | No       | Array of tags                                 |

**Response:** `201 Created`

---

### Get All Media Items

```
GET /workspaces/:workspaceId/media-library/items
```

**Query Parameters:**

| Parameter  | Type     | Required | Default | Description                                   |
| ---------- | -------- | -------- | ------- | --------------------------------------------- |
| type       | enum     | No       | -       | Filter: `image`, `video`, `gif`, `document`   |
| categoryId | uuid     | No       | -       | Filter by category                            |
| isStarred  | boolean  | No       | -       | Filter starred items                          |
| isDeleted  | boolean  | No       | false   | Include deleted items                         |
| search     | string   | No       | -       | Search in name, description                   |
| tags       | string[] | No       | -       | Filter by tags (comma-separated)              |
| limit      | integer  | No       | 50      | Results per page (1-100)                      |
| offset     | integer  | No       | 0       | Skip N results                                |
| sortBy     | enum     | No       | createdAt | Sort by: `createdAt`, `name`, `usageCount`, `lastUsedAt` |
| sortOrder  | enum     | No       | desc    | `asc` or `desc`                               |

**Response:** `200 OK`

```json
{
  "items": [
    {
      "id": "uuid",
      "workspaceId": "uuid",
      "uploadedById": "uuid",
      "type": "image",
      "name": "Product Banner",
      "fileUrl": "https://...",
      "thumbnailUrl": "https://...",
      "mimeType": "image/png",
      "fileSize": 245000,
      "width": 1200,
      "height": 628,
      "tags": ["summer", "banner"],
      "isStarred": false,
      "usageCount": 5,
      "lastUsedAt": "2024-01-14T15:00:00Z",
      "createdAt": "2024-01-10T10:00:00Z",
      "category": {
        "id": "uuid",
        "name": "Marketing Images"
      }
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

---

### Get Recent Media Items

```
GET /workspaces/:workspaceId/media-library/items/recent
```

**Query Parameters:**

| Parameter | Type    | Required | Default | Description          |
| --------- | ------- | -------- | ------- | -------------------- |
| limit     | integer | No       | 20      | Number of items      |

**Response:** `200 OK`

---

### Get Single Media Item

```
GET /workspaces/:workspaceId/media-library/items/:itemId
```

**Response:** `200 OK`

---

### Update Media Item

```
PUT /workspaces/:workspaceId/media-library/items/:itemId
```

**Request Body:**

```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "categoryId": "uuid",
  "tags": ["new", "tags"],
  "isStarred": true
}
```

All fields are optional.

**Response:** `200 OK`

---

### Delete Media Item (Soft Delete)

Moves the item to recycle bin.

```
DELETE /workspaces/:workspaceId/media-library/items/:itemId
```

**Response:** `200 OK`

---

### Restore Media Item

Restores an item from recycle bin.

```
POST /workspaces/:workspaceId/media-library/items/:itemId/restore
```

**Response:** `200 OK`

---

### Permanently Delete Media Item

Permanently deletes the item and removes from Cloudinary.

```
DELETE /workspaces/:workspaceId/media-library/items/:itemId/permanent
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Media item permanently deleted"
}
```

---

### Bulk Actions

```
POST /workspaces/:workspaceId/media-library/items/bulk
```

**Request Body:**

```json
{
  "ids": ["uuid-1", "uuid-2", "uuid-3"],
  "action": "delete",
  "categoryId": "uuid"
}
```

| Field      | Type     | Required | Description                                              |
| ---------- | -------- | -------- | -------------------------------------------------------- |
| ids        | uuid[]   | Yes      | Array of item IDs                                        |
| action     | enum     | Yes      | `delete`, `restore`, `move`, `star`, `unstar`, `permanentDelete` |
| categoryId | uuid     | No       | Required for `move` action                               |

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Bulk action completed",
  "processedCount": 3
}
```

---

## Templates

Templates are reusable post structures with placeholders and media slots.

### Create Template

```
POST /workspaces/:workspaceId/media-library/templates
```

**Request Body:**

```json
{
  "name": "Product Launch Template",
  "description": "Template for product launches",
  "templateType": "post",
  "platforms": ["instagram", "facebook"],
  "content": {
    "text": "Introducing {{product_name}}! {{description}}",
    "mediaSlots": [
      {
        "id": "main-image",
        "label": "Product Image",
        "required": true,
        "acceptedTypes": ["image"]
      }
    ],
    "hashtags": ["newproduct", "launch"],
    "defaultCaption": "Check out our latest!"
  },
  "thumbnailUrl": "https://...",
  "categoryId": "uuid",
  "tags": ["product", "launch"]
}
```

| Field        | Type     | Required | Description                                  |
| ------------ | -------- | -------- | -------------------------------------------- |
| name         | string   | Yes      | Template name (max 255 chars)                |
| description  | string   | No       | Template description                         |
| templateType | enum     | Yes      | `post`, `story`, `reel`, `carousel`          |
| platforms    | string[] | No       | Target platforms                             |
| content      | object   | Yes      | Template content (see below)                 |
| thumbnailUrl | string   | No       | Preview thumbnail                            |
| categoryId   | uuid     | No       | Category to assign                           |
| tags         | string[] | No       | Array of tags                                |

**Content Object:**

| Field          | Type     | Required | Description                    |
| -------------- | -------- | -------- | ------------------------------ |
| text           | string   | Yes      | Template text with placeholders |
| mediaSlots     | array    | Yes      | Media slot definitions         |
| hashtags       | string[] | Yes      | Default hashtags               |
| defaultCaption | string   | No       | Default caption                |

**MediaSlot Object:**

| Field         | Type     | Required | Description                           |
| ------------- | -------- | -------- | ------------------------------------- |
| id            | string   | Yes      | Unique slot identifier                |
| label         | string   | Yes      | Display label                         |
| required      | boolean  | Yes      | Whether media is required             |
| acceptedTypes | enum[]   | Yes      | Array of: `image`, `video`, `gif`     |

**Response:** `201 Created`

---

### Get All Templates

```
GET /workspaces/:workspaceId/media-library/templates
```

**Query Parameters:**

| Parameter    | Type    | Required | Default | Description                        |
| ------------ | ------- | -------- | ------- | ---------------------------------- |
| templateType | enum    | No       | -       | Filter: `post`, `story`, `reel`, `carousel` |
| categoryId   | uuid    | No       | -       | Filter by category                 |
| platform     | string  | No       | -       | Filter by platform                 |
| isStarred    | boolean | No       | -       | Filter starred                     |
| isDeleted    | boolean | No       | false   | Include deleted                    |
| search       | string  | No       | -       | Search in name, description        |
| limit        | integer | No       | 50      | Results per page (1-100)           |
| offset       | integer | No       | 0       | Skip N results                     |

**Response:** `200 OK`

---

### Get Single Template

```
GET /workspaces/:workspaceId/media-library/templates/:templateId
```

**Response:** `200 OK`

---

### Update Template

```
PUT /workspaces/:workspaceId/media-library/templates/:templateId
```

All fields from Create are optional.

**Response:** `200 OK`

---

### Clone Template

```
POST /workspaces/:workspaceId/media-library/templates/:templateId/clone
```

**Request Body:**

```json
{
  "name": "Copy of Product Launch Template"
}
```

| Field | Type   | Required | Description                           |
| ----- | ------ | -------- | ------------------------------------- |
| name  | string | No       | Name for cloned template (auto-generated if not provided) |

**Response:** `201 Created`

---

### Delete Template (Soft Delete)

```
DELETE /workspaces/:workspaceId/media-library/templates/:templateId
```

**Response:** `200 OK`

---

### Restore Template

```
POST /workspaces/:workspaceId/media-library/templates/:templateId/restore
```

**Response:** `200 OK`

---

### Permanently Delete Template

```
DELETE /workspaces/:workspaceId/media-library/templates/:templateId/permanent
```

**Response:** `200 OK`

---

## Text Snippets

Reusable text content like captions, hashtags, and CTAs.

### Create Text Snippet

```
POST /workspaces/:workspaceId/media-library/snippets
```

**Request Body:**

```json
{
  "name": "Summer Sale Caption",
  "snippetType": "caption",
  "content": "Summer is here! Enjoy 20% off all items with code SUMMER20",
  "categoryId": "uuid",
  "tags": ["summer", "sale"]
}
```

| Field       | Type     | Required | Description                          |
| ----------- | -------- | -------- | ------------------------------------ |
| name        | string   | Yes      | Snippet name (max 255 chars)         |
| snippetType | enum     | Yes      | `caption`, `hashtag`, `cta`          |
| content     | string   | Yes      | The snippet content                  |
| categoryId  | uuid     | No       | Category to assign                   |
| tags        | string[] | No       | Array of tags                        |

**Response:** `201 Created`

---

### Get All Text Snippets

```
GET /workspaces/:workspaceId/media-library/snippets
```

**Query Parameters:**

| Parameter   | Type    | Required | Default | Description                    |
| ----------- | ------- | -------- | ------- | ------------------------------ |
| snippetType | enum    | No       | -       | Filter: `caption`, `hashtag`, `cta` |
| categoryId  | uuid    | No       | -       | Filter by category             |
| isStarred   | boolean | No       | -       | Filter starred                 |
| isDeleted   | boolean | No       | false   | Include deleted                |
| search      | string  | No       | -       | Search in name, content        |
| limit       | integer | No       | 50      | Results per page (1-100)       |
| offset      | integer | No       | 0       | Skip N results                 |

**Response:** `200 OK`

---

### Get Single Text Snippet

```
GET /workspaces/:workspaceId/media-library/snippets/:snippetId
```

**Response:** `200 OK`

---

### Update Text Snippet

```
PUT /workspaces/:workspaceId/media-library/snippets/:snippetId
```

**Request Body:**

```json
{
  "name": "Updated Name",
  "snippetType": "caption",
  "content": "Updated content",
  "categoryId": "uuid",
  "tags": ["updated"],
  "isStarred": true
}
```

All fields are optional.

**Response:** `200 OK`

---

### Delete Text Snippet (Soft Delete)

```
DELETE /workspaces/:workspaceId/media-library/snippets/:snippetId
```

**Response:** `200 OK`

---

### Restore Text Snippet

```
POST /workspaces/:workspaceId/media-library/snippets/:snippetId/restore
```

**Response:** `200 OK`

---

### Permanently Delete Text Snippet

```
DELETE /workspaces/:workspaceId/media-library/snippets/:snippetId/permanent
```

**Response:** `200 OK`

---

## Saved Links

Store and organize URLs with automatic preview fetching.

### Create Saved Link

```
POST /workspaces/:workspaceId/media-library/links
```

**Request Body:**

```json
{
  "name": "Company Blog",
  "url": "https://blog.example.com",
  "description": "Our company blog",
  "categoryId": "uuid",
  "tags": ["blog", "content"]
}
```

| Field       | Type     | Required | Description                 |
| ----------- | -------- | -------- | --------------------------- |
| name        | string   | Yes      | Link name (max 255 chars)   |
| url         | string   | Yes      | Valid URL                   |
| description | string   | No       | Link description            |
| categoryId  | uuid     | No       | Category to assign          |
| tags        | string[] | No       | Array of tags               |

The system automatically fetches Open Graph metadata (title, description, image, site name) from the URL.

**Response:** `201 Created`

```json
{
  "id": "uuid",
  "workspaceId": "uuid",
  "createdById": "uuid",
  "name": "Company Blog",
  "url": "https://blog.example.com",
  "description": "Our company blog",
  "previewTitle": "Example Blog - Latest News",
  "previewDescription": "Read our latest articles...",
  "previewImageUrl": "https://blog.example.com/og-image.jpg",
  "previewSiteName": "Example Blog",
  "tags": ["blog", "content"],
  "isStarred": false,
  "usageCount": 0,
  "createdAt": "2024-01-15T10:30:00Z"
}
```

---

### Get All Saved Links

```
GET /workspaces/:workspaceId/media-library/links
```

**Query Parameters:**

| Parameter  | Type    | Required | Default | Description              |
| ---------- | ------- | -------- | ------- | ------------------------ |
| categoryId | uuid    | No       | -       | Filter by category       |
| isStarred  | boolean | No       | -       | Filter starred           |
| isDeleted  | boolean | No       | false   | Include deleted          |
| search     | string  | No       | -       | Search in name, url, description |
| limit      | integer | No       | 50      | Results per page (1-100) |
| offset     | integer | No       | 0       | Skip N results           |

**Response:** `200 OK`

---

### Get Single Saved Link

```
GET /workspaces/:workspaceId/media-library/links/:linkId
```

**Response:** `200 OK`

---

### Update Saved Link

```
PUT /workspaces/:workspaceId/media-library/links/:linkId
```

**Request Body:**

```json
{
  "name": "Updated Name",
  "url": "https://new-url.com",
  "description": "Updated description",
  "categoryId": "uuid",
  "tags": ["updated"],
  "isStarred": true
}
```

All fields are optional. If `url` is changed, preview metadata is automatically re-fetched.

**Response:** `200 OK`

---

### Refresh Link Preview

Manually re-fetch Open Graph metadata for a link.

```
POST /workspaces/:workspaceId/media-library/links/:linkId/refresh-preview
```

**Response:** `200 OK`

---

### Delete Saved Link (Soft Delete)

```
DELETE /workspaces/:workspaceId/media-library/links/:linkId
```

**Response:** `200 OK`

---

### Restore Saved Link

```
POST /workspaces/:workspaceId/media-library/links/:linkId/restore
```

**Response:** `200 OK`

---

### Permanently Delete Saved Link

```
DELETE /workspaces/:workspaceId/media-library/links/:linkId/permanent
```

**Response:** `200 OK`

---

## Recycle Bin

Items that are soft-deleted go to the recycle bin. They are automatically permanently deleted after 30 days.

### Get Recycle Bin Contents

```
GET /workspaces/:workspaceId/media-library/recycle-bin
```

**Query Parameters:**

| Parameter | Type    | Required | Default | Description                                                              |
| --------- | ------- | -------- | ------- | ------------------------------------------------------------------------ |
| type      | enum    | No       | -       | Filter: `image`, `video`, `gif`, `document`, `template`, `text_snippet`, `link` |
| limit     | integer | No       | 50      | Results per page (1-100)                                                 |
| offset    | integer | No       | 0       | Skip N results                                                           |

**Response:** `200 OK`

```json
{
  "mediaItems": {
    "items": [...],
    "total": 5,
    "limit": 50,
    "offset": 0
  },
  "templates": {
    "items": [...],
    "total": 2,
    "limit": 50,
    "offset": 0
  },
  "textSnippets": {
    "items": [...],
    "total": 1,
    "limit": 50,
    "offset": 0
  },
  "savedLinks": {
    "items": [...],
    "total": 0,
    "limit": 50,
    "offset": 0
  }
}
```

---

### Empty Recycle Bin

Permanently delete all items in the recycle bin.

```
POST /workspaces/:workspaceId/media-library/recycle-bin/empty
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Permanently deleted 8 items from recycle bin",
  "deletedCount": 8
}
```

---

## Automatic Cleanup

A scheduled job runs daily at 3:00 AM to permanently delete items that have been in the recycle bin for more than 30 days. This applies to:
- Media items
- Templates
- Text snippets
- Saved links

---

## Error Responses

All endpoints may return the following error responses:

### 400 Bad Request

```json
{
  "statusCode": 400,
  "message": ["name must be a string", "type must be a valid enum value"],
  "error": "Bad Request"
}
```

### 401 Unauthorized

```json
{
  "statusCode": 401,
  "message": "Unauthorized"
}
```

### 404 Not Found

```json
{
  "statusCode": 404,
  "message": "Media item not found"
}
```

### 500 Internal Server Error

```json
{
  "statusCode": 500,
  "message": "Internal server error"
}
```
