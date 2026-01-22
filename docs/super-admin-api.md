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
5. [Suspension Reasons](#suspension-reasons)

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
