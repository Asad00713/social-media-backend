# Super Admin API Documentation

Base URL: `/admin`

All endpoints require:
1. JWT authentication via `Authorization: Bearer <token>` header
2. User must have `SUPER_ADMIN` role

---

## Table of Contents

1. [Dashboard](#dashboard)
2. [User Management](#user-management)
3. [Workspace Management](#workspace-management)
4. [Analytics](#analytics)
5. [User Inactivity](#user-inactivity)
6. [AI Usage](#ai-usage)
7. [Queue Monitoring](#queue-monitoring)
8. [Rate Limiting](#rate-limiting)
9. [Suspension Reasons](#suspension-reasons)

---

## Dashboard

### Get Dashboard Overview

Returns overall platform statistics.

```
GET /admin/dashboard
```

**Response:** `200 OK`

```json
{
  "users": {
    "total": 1250,
    "active": 1180,
    "suspended": 70,
    "newLast30Days": 145
  },
  "workspaces": {
    "total": 890,
    "active": 865,
    "suspended": 25
  },
  "channels": {
    "total": 2340,
    "connected": 2100,
    "disconnected": 240
  },
  "posts": {
    "total": 15420,
    "published": 12500,
    "scheduled": 1820,
    "failed": 100
  }
}
```

---

### Get Recent Activity

Returns recently registered users and created workspaces.

```
GET /admin/dashboard/activity
```

**Query Parameters:**

| Parameter | Type    | Required | Default | Description              |
|-----------|---------|----------|---------|--------------------------|
| limit     | integer | No       | 20      | Number of items to return |

**Response:** `200 OK`

```json
{
  "recentUsers": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "name": "John Doe",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ],
  "recentWorkspaces": [
    {
      "id": "uuid",
      "name": "My Workspace",
      "slug": "my-workspace",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

---

### Get System Health

Returns system health status and issue counts.

```
GET /admin/dashboard/health
```

**Response:** `200 OK`

```json
{
  "status": "healthy",
  "issues": {
    "expiredChannels": 15,
    "failedPosts": 8,
    "unresolvedPayments": 3
  },
  "timestamp": "2024-01-15T10:30:00Z"
}
```

---

## User Management

### List Users

Get paginated list of all users with filters.

```
GET /admin/users
```

**Query Parameters:**

| Parameter | Type    | Required | Default | Description                          |
|-----------|---------|----------|---------|--------------------------------------|
| page      | integer | No       | 1       | Page number                          |
| limit     | integer | No       | 20      | Results per page                     |
| search    | string  | No       | -       | Search by email or name              |
| isActive  | boolean | No       | -       | Filter by active status (true/false) |
| role      | string  | No       | -       | Filter by role (USER, ADMIN, SUPER_ADMIN) |

**Response:** `200 OK`

```json
{
  "users": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "name": "John Doe",
      "role": "USER",
      "isEmailVerified": true,
      "isActive": true,
      "suspendedAt": null,
      "suspendedReason": null,
      "lastLoginAt": "2024-01-14T15:00:00Z",
      "createdAt": "2024-01-01T10:00:00Z"
    },
    {
      "id": "uuid",
      "email": "suspended@example.com",
      "name": "Jane Smith",
      "role": "USER",
      "isEmailVerified": true,
      "isActive": false,
      "suspendedAt": "2024-01-10T12:00:00Z",
      "suspendedReason": "non_payment",
      "lastLoginAt": "2024-01-09T08:00:00Z",
      "createdAt": "2023-12-15T10:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1250,
    "totalPages": 63
  }
}
```

---

### Get User Details

Get detailed information about a specific user including their workspaces.

```
GET /admin/users/:userId
```

**Response:** `200 OK`

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "role": "USER",
  "isEmailVerified": true,
  "isActive": true,
  "suspendedAt": null,
  "suspendedReason": null,
  "suspensionNote": null,
  "lastLoginAt": "2024-01-14T15:00:00Z",
  "createdAt": "2024-01-01T10:00:00Z",
  "updatedAt": "2024-01-14T15:00:00Z",
  "workspaces": [
    {
      "id": "uuid",
      "name": "My Workspace",
      "slug": "my-workspace",
      "isActive": true,
      "createdAt": "2024-01-02T10:00:00Z"
    },
    {
      "id": "uuid",
      "name": "Team Workspace",
      "slug": "team-workspace",
      "isActive": true,
      "createdAt": "2024-01-05T10:00:00Z"
    }
  ]
}
```

**Error Response:** `404 Not Found`

```json
{
  "statusCode": 404,
  "message": "User not found"
}
```

---

### Suspend User

Suspend a user account. Suspended users cannot login.

```
POST /admin/users/:userId/suspend
```

**Request Body:**

```json
{
  "reason": "non_payment",
  "note": "Failed payment after 3 attempts. Customer notified."
}
```

| Field  | Type   | Required | Description                              |
|--------|--------|----------|------------------------------------------|
| reason | enum   | Yes      | One of: `non_payment`, `policy_violation`, `abuse`, `user_request`, `manual` |
| note   | string | No       | Internal note about the suspension       |

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "User user@example.com has been suspended",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "isActive": false,
    "suspendedAt": "2024-01-15T10:30:00Z",
    "suspendedReason": "non_payment"
  }
}
```

**Error Responses:**

`400 Bad Request` - Invalid reason
```json
{
  "error": "Invalid suspension reason",
  "validReasons": ["non_payment", "policy_violation", "abuse", "user_request", "manual"]
}
```

`400 Bad Request` - User already suspended
```json
{
  "statusCode": 400,
  "message": "User is already suspended"
}
```

`400 Bad Request` - Cannot suspend super admin
```json
{
  "statusCode": 400,
  "message": "Cannot suspend a super admin"
}
```

---

### Reactivate User

Reactivate a suspended user account.

```
POST /admin/users/:userId/reactivate
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "User user@example.com has been reactivated"
}
```

**Error Response:** `400 Bad Request`

```json
{
  "statusCode": 400,
  "message": "User is not suspended"
}
```

---

## Workspace Management

### List Workspaces

Get paginated list of all workspaces with owner information.

```
GET /admin/workspaces
```

**Query Parameters:**

| Parameter | Type    | Required | Default | Description                          |
|-----------|---------|----------|---------|--------------------------------------|
| page      | integer | No       | 1       | Page number                          |
| limit     | integer | No       | 20      | Results per page                     |
| search    | string  | No       | -       | Search by name, slug, or owner email |
| isActive  | boolean | No       | -       | Filter by active status              |

**Response:** `200 OK`

```json
{
  "workspaces": [
    {
      "id": "uuid",
      "name": "Marketing Team",
      "slug": "marketing-team",
      "isActive": true,
      "suspendedAt": null,
      "suspendedReason": null,
      "ownerId": "uuid",
      "createdAt": "2024-01-01T10:00:00Z",
      "owner": {
        "id": "uuid",
        "email": "owner@example.com",
        "name": "John Doe"
      }
    },
    {
      "id": "uuid",
      "name": "Suspended Workspace",
      "slug": "suspended-workspace",
      "isActive": false,
      "suspendedAt": "2024-01-10T12:00:00Z",
      "suspendedReason": "policy_violation",
      "ownerId": "uuid",
      "createdAt": "2023-11-15T10:00:00Z",
      "owner": {
        "id": "uuid",
        "email": "violator@example.com",
        "name": "Jane Smith"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 890,
    "totalPages": 45
  }
}
```

---

### Get Workspace Details

Get detailed information about a specific workspace including stats and subscription.

```
GET /admin/workspaces/:workspaceId
```

**Response:** `200 OK`

```json
{
  "id": "uuid",
  "name": "Marketing Team",
  "slug": "marketing-team",
  "description": "Our marketing department workspace",
  "logo": "https://example.com/logo.png",
  "timezone": "America/New_York",
  "isActive": true,
  "suspendedAt": null,
  "suspendedReason": null,
  "suspensionNote": null,
  "ownerId": "uuid",
  "createdAt": "2024-01-01T10:00:00Z",
  "updatedAt": "2024-01-14T15:00:00Z",
  "owner": {
    "id": "uuid",
    "email": "owner@example.com",
    "name": "John Doe"
  },
  "stats": {
    "channelsCount": 5,
    "postsCount": 234
  },
  "subscription": {
    "planCode": "PRO",
    "status": "active",
    "currentPeriodEnd": "2024-02-01T00:00:00Z"
  }
}
```

---

### Suspend Workspace

Suspend a workspace. All members will lose access.

```
POST /admin/workspaces/:workspaceId/suspend
```

**Request Body:**

```json
{
  "reason": "policy_violation",
  "note": "Posting prohibited content. Multiple warnings ignored."
}
```

| Field  | Type   | Required | Description                              |
|--------|--------|----------|------------------------------------------|
| reason | enum   | Yes      | One of: `non_payment`, `policy_violation`, `abuse`, `user_request`, `manual` |
| note   | string | No       | Internal note about the suspension       |

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Workspace \"Marketing Team\" has been suspended",
  "workspace": {
    "id": "uuid",
    "name": "Marketing Team",
    "isActive": false,
    "suspendedAt": "2024-01-15T10:30:00Z",
    "suspendedReason": "policy_violation"
  }
}
```

---

### Reactivate Workspace

Reactivate a suspended workspace.

```
POST /admin/workspaces/:workspaceId/reactivate
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Workspace \"Marketing Team\" has been reactivated"
}
```

---

## Analytics

### Channel Statistics

Get channel analytics by platform and connection status.

```
GET /admin/analytics/channels
```

**Response:** `200 OK`

```json
{
  "byPlatform": [
    { "platform": "instagram", "count": 850 },
    { "platform": "facebook", "count": 720 },
    { "platform": "twitter", "count": 450 },
    { "platform": "linkedin", "count": 320 }
  ],
  "byStatus": [
    { "status": "connected", "count": 2100 },
    { "status": "expired", "count": 180 },
    { "status": "error", "count": 45 },
    { "status": "revoked", "count": 15 }
  ],
  "problemChannels": [
    {
      "id": 123,
      "platform": "instagram",
      "accountName": "mybusiness",
      "connectionStatus": "expired",
      "lastError": "Token expired",
      "lastErrorAt": "2024-01-14T10:00:00Z",
      "workspaceId": "uuid"
    }
  ]
}
```

---

### Post Statistics

Get post analytics by status and recent failures.

```
GET /admin/analytics/posts
```

**Response:** `200 OK`

```json
{
  "byStatus": [
    { "status": "published", "count": 12500 },
    { "status": "scheduled", "count": 1820 },
    { "status": "draft", "count": 950 },
    { "status": "failed", "count": 100 },
    { "status": "publishing", "count": 50 }
  ],
  "recentFailed": [
    {
      "id": "uuid",
      "workspaceId": "uuid",
      "status": "failed",
      "lastError": "Media upload failed: File too large",
      "scheduledAt": "2024-01-14T15:00:00Z",
      "createdAt": "2024-01-14T10:00:00Z"
    }
  ],
  "last30Days": [
    { "date": "2024-01-01", "count": 450 },
    { "date": "2024-01-02", "count": 520 },
    { "date": "2024-01-03", "count": 480 }
  ]
}
```

---

### Revenue Statistics

Get revenue and subscription analytics.

```
GET /admin/analytics/revenue
```

**Response:** `200 OK`

```json
{
  "subscriptions": {
    "byStatus": [
      { "status": "active", "count": 750 },
      { "status": "trialing", "count": 120 },
      { "status": "past_due", "count": 25 },
      { "status": "canceled", "count": 85 }
    ],
    "byPlan": [
      { "planCode": "FREE", "count": 500 },
      { "planCode": "STARTER", "count": 280 },
      { "planCode": "PRO", "count": 150 },
      { "planCode": "BUSINESS", "count": 50 }
    ]
  },
  "revenue": {
    "totalCents": 15840000,
    "totalFormatted": "$158400.00",
    "last30DaysCents": 4250000,
    "last30DaysFormatted": "$42500.00"
  },
  "recentFailedPayments": [
    {
      "id": 1,
      "subscriptionId": 123,
      "failureReason": "Card declined - insufficient funds",
      "attemptCount": 2,
      "resolved": false,
      "createdAt": "2024-01-14T10:00:00Z"
    }
  ]
}
```

---

## User Inactivity

### Get Inactivity Statistics

Returns statistics about inactive users across different stages.

```
GET /admin/inactivity/stats
```

**Response:** `200 OK`

```json
{
  "inactive15Days": 45,
  "inactive25Days": 12,
  "deactivated30Days": 5,
  "pendingDeletion365Days": 2,
  "lastCheckAt": "2024-01-15T06:00:00Z"
}
```

---

### Get Inactivity Email Statistics

Returns count of inactivity emails triggered per workspace.

```
GET /admin/inactivity/email-stats
```

**Response:** `200 OK`

```json
{
  "emailStats": [
    {
      "workspaceId": "uuid",
      "workspaceName": "Marketing Team",
      "emails15Days": 10,
      "emails25Days": 3,
      "deactivationEmails": 1
    }
  ],
  "totals": {
    "total15DayEmails": 150,
    "total25DayEmails": 45,
    "totalDeactivationEmails": 12
  }
}
```

---

### Run Manual Inactivity Check

Manually trigger the inactivity check job (normally runs daily via cron).

```
POST /admin/inactivity/run-check
```

**Response:** `200 OK`

```json
{
  "success": true,
  "processed": {
    "warning15Days": 45,
    "warning25Days": 12,
    "deactivated": 5,
    "deleted": 0
  },
  "runAt": "2024-01-15T10:30:00Z"
}
```

---

## AI Usage

### Get AI Usage Statistics

Returns comprehensive AI usage statistics across the platform.

```
GET /admin/ai-usage/stats
```

**Response:** `200 OK`

```json
{
  "totals": {
    "totalTokensUsed": 125000,
    "totalOperations": 8500
  },
  "last30Days": {
    "tokensUsed": 45000,
    "operations": 3200
  },
  "last7Days": {
    "tokensUsed": 12000,
    "operations": 850
  },
  "byOperation": [
    { "operation": "generate_post", "count": 3500, "tokensUsed": 17500 },
    { "operation": "generate_caption", "count": 2100, "tokensUsed": 10500 },
    { "operation": "generate_hashtags", "count": 1800, "tokensUsed": 3600 },
    { "operation": "speech_to_text", "count": 500, "tokensUsed": 2500 },
    { "operation": "generate_thread", "count": 200, "tokensUsed": 2000 }
  ],
  "byWorkspace": [
    {
      "workspaceId": "uuid",
      "workspaceName": "Marketing Team",
      "tokensUsed": 15000,
      "operations": 1200
    },
    {
      "workspaceId": "uuid",
      "workspaceName": "Sales Team",
      "tokensUsed": 8500,
      "operations": 650
    }
  ]
}
```

---

### Get AI Usage Activity

Returns recent AI usage activity logs with user and workspace details.

```
GET /admin/ai-usage/activity
```

**Query Parameters:**

| Parameter | Type    | Required | Default | Description              |
|-----------|---------|----------|---------|--------------------------|
| limit     | integer | No       | 50      | Number of items to return |

**Response:** `200 OK`

```json
{
  "activity": [
    {
      "id": 12345,
      "operation": "generate_post",
      "tokensUsed": 5,
      "platform": "instagram",
      "inputSummary": "Post about: Summer fashion trends...",
      "outputLength": 280,
      "success": true,
      "errorMessage": null,
      "createdAt": "2024-01-15T10:30:00Z",
      "user": {
        "id": "uuid",
        "email": "user@example.com",
        "name": "John Doe"
      },
      "workspace": {
        "id": "uuid",
        "name": "Marketing Team"
      }
    },
    {
      "id": 12344,
      "operation": "speech_to_text",
      "tokensUsed": 5,
      "platform": null,
      "inputSummary": "Voice transcription: recording.webm",
      "outputLength": 450,
      "success": true,
      "errorMessage": null,
      "createdAt": "2024-01-15T10:25:00Z",
      "user": {
        "id": "uuid",
        "email": "jane@example.com",
        "name": "Jane Smith"
      },
      "workspace": {
        "id": "uuid",
        "name": "Sales Team"
      }
    }
  ]
}
```

---

### AI Token Costs Reference

| Operation | Tokens | Description |
|-----------|--------|-------------|
| `generate_hashtags` | 2 | Generate hashtags for a topic |
| `generate_bio` | 2 | Generate social media bio |
| `generate_post` | 5 | Generate a social media post |
| `generate_caption` | 5 | Generate media caption |
| `improve_post` | 5 | Improve existing post |
| `repurpose_content` | 5 | Repurpose content across platforms |
| `translate_content` | 5 | Translate content |
| `speech_to_text` | 5 | Voice transcription (max 3 min) |
| `generate_ideas` | 8 | Generate content ideas |
| `generate_youtube_metadata` | 8 | Generate YouTube metadata |
| `generate_variations` | 8 | Generate post variations |
| `analyze_post` | 8 | Analyze post performance |
| `generate_thread` | 10 | Generate Twitter/Threads thread |
| `generate_drip_content` | 15 | Generate drip campaign content |

---

### AI Token Limits by Plan

| Plan | Monthly Tokens | Can Purchase Add-ons |
|------|----------------|---------------------|
| FREE | 0 (no AI access) | No |
| PRO | 2,000 | Yes ($5.00 per 500 tokens) |
| MAX | 5,000 | Yes ($4.00 per 500 tokens) |

---

## Queue Monitoring

Monitor and manage BullMQ job queues for post publishing, token refresh, and drip campaigns.

### Available Queues

| Queue Name | Description |
|------------|-------------|
| `post-publishing` | Handles scheduled post publishing to social media |
| `token-refresh` | Handles OAuth token refresh operations |
| `drip-campaigns` | Handles automated drip campaign content generation and publishing |

---

### Get All Queues Overview

Returns overview of all queues with aggregate statistics.

```
GET /admin/queues
```

**Response:** `200 OK`

```json
{
  "queues": [
    {
      "name": "post-publishing",
      "waiting": 25,
      "active": 3,
      "completed": 15420,
      "failed": 45,
      "delayed": 150,
      "paused": false
    },
    {
      "name": "token-refresh",
      "waiting": 0,
      "active": 0,
      "completed": 8500,
      "failed": 12,
      "delayed": 0,
      "paused": false
    },
    {
      "name": "drip-campaigns",
      "waiting": 5,
      "active": 1,
      "completed": 3200,
      "failed": 8,
      "delayed": 45,
      "paused": false
    }
  ],
  "aggregate": {
    "totalWaiting": 30,
    "totalActive": 4,
    "totalCompleted": 27120,
    "totalFailed": 65,
    "totalDelayed": 195,
    "queuesHealthy": 3,
    "queuesPaused": 0
  },
  "availableQueues": ["post-publishing", "token-refresh", "drip-campaigns"]
}
```

---

### Get Queue Statistics

Get detailed statistics for a specific queue.

```
GET /admin/queues/:queueName
```

**Response:** `200 OK`

```json
{
  "name": "post-publishing",
  "waiting": 25,
  "active": 3,
  "completed": 15420,
  "failed": 45,
  "delayed": 150,
  "paused": false
}
```

---

### Get Failed Jobs

Get list of failed jobs in a queue.

```
GET /admin/queues/:queueName/failed
```

**Query Parameters:**

| Parameter | Type    | Required | Default | Description              |
|-----------|---------|----------|---------|--------------------------|
| limit     | integer | No       | 20      | Number of jobs to return |

**Response:** `200 OK`

```json
{
  "queueName": "post-publishing",
  "jobs": [
    {
      "id": "123",
      "name": "publish-post",
      "data": {
        "postId": "uuid",
        "channelId": "uuid",
        "workspaceId": "uuid"
      },
      "failedReason": "Instagram API rate limit exceeded",
      "attemptsMade": 3,
      "timestamp": 1705315800000,
      "processedOn": 1705315801000,
      "finishedOn": 1705315802000
    }
  ],
  "count": 1
}
```

---

### Get Active Jobs

Get currently processing jobs.

```
GET /admin/queues/:queueName/active
```

**Query Parameters:**

| Parameter | Type    | Required | Default | Description              |
|-----------|---------|----------|---------|--------------------------|
| limit     | integer | No       | 20      | Number of jobs to return |

**Response:** `200 OK`

```json
{
  "queueName": "post-publishing",
  "jobs": [
    {
      "id": "456",
      "name": "publish-post",
      "data": {
        "postId": "uuid",
        "channelId": "uuid"
      },
      "progress": 50,
      "attemptsMade": 1,
      "timestamp": 1705315800000,
      "processedOn": 1705315801000
    }
  ],
  "count": 1
}
```

---

### Get Waiting Jobs

Get jobs waiting to be processed.

```
GET /admin/queues/:queueName/waiting
```

---

### Get Delayed Jobs

Get jobs scheduled for future processing.

```
GET /admin/queues/:queueName/delayed
```

---

### Get Completed Jobs

Get recently completed jobs.

```
GET /admin/queues/:queueName/completed
```

---

### Retry Failed Job

Retry a specific failed job.

```
POST /admin/queues/:queueName/retry
```

**Request Body:**

```json
{
  "jobId": "123"
}
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Job 123 has been queued for retry"
}
```

---

### Retry All Failed Jobs

Retry all failed jobs in a queue.

```
POST /admin/queues/:queueName/retry-all
```

**Response:** `200 OK`

```json
{
  "success": true,
  "count": 45,
  "message": "Retried 45 failed jobs"
}
```

---

### Remove Job

Remove a specific job from the queue.

```
POST /admin/queues/:queueName/remove
```

**Request Body:**

```json
{
  "jobId": "123"
}
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Job 123 has been removed"
}
```

---

### Clean Queue

Clean old jobs from a queue.

```
POST /admin/queues/:queueName/clean
```

**Request Body:**

```json
{
  "type": "completed",
  "gracePeriodHours": 24
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| type | enum | Yes | - | One of: `completed`, `failed`, `delayed`, `wait` |
| gracePeriodHours | integer | No | 24 | Only clean jobs older than this |

**Response:** `200 OK`

```json
{
  "success": true,
  "count": 1500,
  "message": "Cleaned 1500 completed jobs older than 24 hours"
}
```

---

### Pause Queue

Pause a queue (stops processing new jobs).

```
POST /admin/queues/:queueName/pause
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Queue post-publishing has been paused"
}
```

---

### Resume Queue

Resume a paused queue.

```
POST /admin/queues/:queueName/resume
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Queue post-publishing has been resumed"
}
```

---

## Rate Limiting

Monitor API rate limits per social media platform. The system uses sliding window rate limiting to stay within each platform's API limits.

### Get All Rate Limits

Get current rate limit status for all platforms.

```
GET /admin/rate-limits
```

**Response:** `200 OK`

```json
{
  "platforms": {
    "twitter": {
      "current": 45,
      "max": 200,
      "remaining": 155,
      "windowMs": 10800000,
      "description": "200 tweets per 3 hours"
    },
    "facebook": {
      "current": 12,
      "max": 150,
      "remaining": 138,
      "windowMs": 3600000,
      "description": "150 posts per hour"
    },
    "instagram": {
      "current": 8,
      "max": 20,
      "remaining": 12,
      "windowMs": 86400000,
      "description": "20 posts per 24 hours"
    },
    "linkedin": {
      "current": 0,
      "max": 80,
      "remaining": 80,
      "windowMs": 86400000,
      "description": "80 posts per 24 hours"
    },
    "tiktok": {
      "current": 2,
      "max": 8,
      "remaining": 6,
      "windowMs": 86400000,
      "description": "8 videos per 24 hours"
    }
  },
  "limits": {
    "twitter": { "maxRequests": 200, "windowMs": 10800000, "description": "200 tweets per 3 hours" },
    "facebook": { "maxRequests": 150, "windowMs": 3600000, "description": "150 posts per hour" },
    "instagram": { "maxRequests": 20, "windowMs": 86400000, "description": "20 posts per 24 hours" },
    "linkedin": { "maxRequests": 80, "windowMs": 86400000, "description": "80 posts per 24 hours" },
    "pinterest": { "maxRequests": 50, "windowMs": 3600000, "description": "50 pins per hour" },
    "tiktok": { "maxRequests": 8, "windowMs": 86400000, "description": "8 videos per 24 hours" },
    "youtube": { "maxRequests": 50, "windowMs": 86400000, "description": "50 videos per 24 hours" },
    "threads": { "maxRequests": 20, "windowMs": 86400000, "description": "20 posts per 24 hours" }
  }
}
```

---

### Get Platform Rate Limit

Get detailed rate limit status for a specific platform.

```
GET /admin/rate-limits/:platform
```

**Response:** `200 OK`

```json
{
  "platform": "instagram",
  "current": 8,
  "max": 20,
  "remaining": 12,
  "resetAt": "2024-01-16T10:30:00Z",
  "limit": {
    "maxRequests": 20,
    "windowMs": 86400000,
    "description": "20 posts per 24 hours"
  }
}
```

---

### Platform Rate Limits Reference

| Platform | Max Requests | Window | Notes |
|----------|-------------|--------|-------|
| Twitter | 200 | 3 hours | Conservative limit (API allows 300) |
| Facebook | 150 | 1 hour | Conservative limit (API allows ~200) |
| Instagram | 20 | 24 hours | Very strict platform limit |
| LinkedIn | 80 | 24 hours | Conservative limit |
| Pinterest | 50 | 1 hour | Relatively generous |
| TikTok | 8 | 24 hours | Very strict platform limit |
| YouTube | 50 | 24 hours | Daily upload limit varies |
| Threads | 20 | 24 hours | Similar to Instagram |
| Google Drive | 1000 | 1 hour | Read operations |
| Google Photos | 1000 | 1 hour | Read operations |
| OneDrive | 10000 | 10 minutes | Microsoft Graph limits |
| Dropbox | 1000 | 1 hour | Varies by endpoint |

### Per-Channel Rate Limits

In addition to global platform limits, these per-account limits apply:

| Platform | Max per Account | Window |
|----------|----------------|--------|
| Instagram | 10 | 24 hours |
| TikTok | 5 | 24 hours |
| Twitter | 50 | 1 hour |

---

## Suspension Reasons

The following suspension reasons are supported for both users and workspaces:

| Reason             | Description                                      |
|--------------------|--------------------------------------------------|
| `non_payment`      | Failed to pay subscription after grace period    |
| `policy_violation` | Violated terms of service or acceptable use      |
| `abuse`            | Spam, excessive API usage, or malicious activity |
| `user_request`     | User requested account/workspace closure         |
| `manual`           | Manual admin action (specify details in note)    |

---

## What Happens When Suspended

### User Suspended
- User cannot login (receives "Your account has been suspended" error)
- All active sessions are invalidated
- User's workspaces remain accessible to other members
- Scheduled posts continue to run

### Workspace Suspended
- All members lose access to the workspace
- Returns "This workspace has been suspended" error
- Scheduled posts will fail (cannot access workspace)
- Data is preserved (not deleted)

---

## Error Responses

### 401 Unauthorized

```json
{
  "statusCode": 401,
  "message": "Unauthorized"
}
```

### 403 Forbidden (Not Super Admin)

```json
{
  "statusCode": 403,
  "message": "Super admin access required"
}
```

### 404 Not Found

```json
{
  "statusCode": 404,
  "message": "User not found"
}
```

### 400 Bad Request

```json
{
  "statusCode": 400,
  "message": "User is already suspended"
}
```
