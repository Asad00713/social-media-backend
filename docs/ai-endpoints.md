# AI Content Generation API

This module provides AI-powered content generation for social media using Groq's Llama 3.3 70B model.

## Configuration

Add the following environment variable:

```env
GROQ_API_KEY=your_groq_api_key_here
```

Get your free API key from: https://console.groq.com/keys

## Authentication

All endpoints require JWT authentication. Include the token in the Authorization header:

```
Authorization: Bearer <your_jwt_token>
```

---

## Endpoints

### 1. Check AI Status

Check if the AI service is configured and ready.

**Endpoint:** `GET /ai/status`

**Response:**
```json
{
  "configured": true,
  "message": "AI service is configured and ready",
  "model": "llama-3.3-70b-versatile"
}
```

---

### 2. Get Available Options

Get the list of supported platforms and tones.

**Endpoint:** `GET /ai/options`

**Response:**
```json
{
  "platforms": ["twitter", "linkedin", "facebook", "instagram", "threads", "pinterest", "youtube"],
  "tones": ["professional", "casual", "humorous", "inspirational", "educational", "promotional", "storytelling", "urgent", "conversational", "authoritative"]
}
```

---

### 3. Generate Post

Generate a complete social media post for a specific platform.

**Endpoint:** `POST /ai/generate/post`

**Use Case:** Create platform-optimized posts from a topic or idea.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| topic | string | Yes | The topic or idea for the post (3-500 chars) |
| platform | string | Yes | Target platform (twitter, linkedin, facebook, instagram, threads, pinterest, youtube) |
| tone | string | No | Desired tone (professional, casual, humorous, etc.) |
| additionalContext | string | No | Extra context or instructions (max 1000 chars) |

**Example Request:**
```json
{
  "topic": "Benefits of remote work for software developers",
  "platform": "linkedin",
  "tone": "professional",
  "additionalContext": "Target audience is tech recruiters and HR managers"
}
```

**Example Response:**
```json
{
  "content": "Remote work isn't just a perk—it's a productivity multiplier for software developers.\n\nHere's what the data shows:\n\n→ 67% of developers report higher productivity at home\n→ Zero commute = 2+ hours saved daily\n→ Flexible schedules align with peak coding hours\n→ Reduced interruptions mean deeper focus\n\nThe best talent is no longer limited by geography. Companies embracing remote-first cultures are winning the war for top developers.\n\nIs your organization ready to compete?\n\n#RemoteWork #SoftwareDevelopment #TechTalent #FutureOfWork"
}
```

---

### 4. Generate Caption

Generate a caption for images or videos.

**Endpoint:** `POST /ai/generate/caption`

**Use Case:** Create engaging captions for media content (photos, videos, graphics).

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| description | string | Yes | Description of the media content (3-1000 chars) |
| platform | string | Yes | Target platform |
| tone | string | No | Desired tone |
| includeHashtags | boolean | No | Whether to include hashtags (default: false) |
| includeCta | boolean | No | Whether to include a call-to-action (default: false) |

**Example Request:**
```json
{
  "description": "A photo of our team celebrating after successfully launching our new mobile app",
  "platform": "instagram",
  "tone": "casual",
  "includeHashtags": true,
  "includeCta": true
}
```

**Example Response:**
```json
{
  "content": "That feeling when months of hard work finally pays off! 🎉\n\nOur team just shipped the new app and we couldn't be prouder of what we built together. Late nights, endless debugging sessions, and way too much coffee—but totally worth it.\n\nDownload it now and let us know what you think! Link in bio 👆\n\n#AppLaunch #StartupLife #TeamWork #TechStartup #ProductLaunch #Celebration #BuildInPublic"
}
```

---

### 5. Generate Hashtags

Generate relevant hashtags for a topic.

**Endpoint:** `POST /ai/generate/hashtags`

**Use Case:** Find trending and relevant hashtags to increase post visibility.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| topic | string | Yes | Topic to generate hashtags for (3-500 chars) |
| platform | string | Yes | Target platform (affects quantity and style) |
| count | number | No | Number of hashtags to generate (1-30, default: 10) |

**Example Request:**
```json
{
  "topic": "Healthy meal prep for busy professionals",
  "platform": "instagram",
  "count": 15
}
```

**Example Response:**
```json
{
  "hashtags": [
    "#MealPrep",
    "#HealthyEating",
    "#MealPrepSunday",
    "#HealthyLifestyle",
    "#CleanEating",
    "#FoodPrep",
    "#HealthyRecipes",
    "#BusyLifestyle",
    "#NutritionTips",
    "#MealPrepIdeas",
    "#HealthyLunch",
    "#WorkLunch",
    "#FitFood",
    "#EatClean",
    "#PrepLife"
  ]
}
```

---

### 6. Generate Content Ideas

Generate content ideas for a specific niche.

**Endpoint:** `POST /ai/generate/ideas`

**Use Case:** Plan your content calendar with fresh, engaging ideas.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| niche | string | Yes | Your niche or industry (3-200 chars) |
| platform | string | Yes | Target platform |
| count | number | No | Number of ideas to generate (1-20, default: 5) |
| contentType | string | No | Type of content (educational, entertaining, promotional, etc.) |

**Example Request:**
```json
{
  "niche": "Personal finance for millennials",
  "platform": "instagram",
  "count": 5,
  "contentType": "educational"
}
```

**Example Response:**
```json
{
  "ideas": [
    {
      "title": "The Latte Factor Myth",
      "description": "Debunk the idea that skipping coffee will make you rich—focus on big wins instead",
      "format": "carousel"
    },
    {
      "title": "Emergency Fund Challenge",
      "description": "30-day challenge to save your first $1,000 with daily actionable tips",
      "format": "reels series"
    },
    {
      "title": "Credit Score Breakdown",
      "description": "Visual explanation of what affects your credit score and how to improve it",
      "format": "infographic carousel"
    },
    {
      "title": "Investing vs Saving",
      "description": "Show the compound growth difference between keeping money in savings vs investing",
      "format": "single image with stats"
    },
    {
      "title": "Budget Template Giveaway",
      "description": "Free downloadable budget spreadsheet with video tutorial on how to use it",
      "format": "reel + free resource"
    }
  ]
}
```

---

### 7. Generate YouTube Metadata

Generate optimized title, description, and tags for YouTube videos.

**Endpoint:** `POST /ai/generate/youtube-metadata`

**Use Case:** Create SEO-optimized metadata to improve video discoverability.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| videoDescription | string | Yes | Description of your video content (10-2000 chars) |
| targetAudience | string | No | Who the video is for (max 200 chars) |

**Example Request:**
```json
{
  "videoDescription": "A complete tutorial on building a REST API using NestJS with TypeScript, PostgreSQL database, and JWT authentication. Covers project setup, controllers, services, database integration, and deployment.",
  "targetAudience": "Beginner to intermediate backend developers"
}
```

**Example Response:**
```json
{
  "title": "Build a REST API with NestJS & PostgreSQL - Complete Tutorial 2024",
  "description": "Learn how to build a production-ready REST API from scratch using NestJS, TypeScript, and PostgreSQL!\n\nIn this comprehensive tutorial, you'll learn:\n- Setting up a NestJS project with TypeScript\n- Creating controllers and services\n- Connecting to PostgreSQL database\n- Implementing JWT authentication\n- Best practices for API development\n- Deploying your API to production\n\n⏱️ TIMESTAMPS:\n0:00 - Introduction\n2:30 - Project Setup\n10:00 - Creating Controllers\n25:00 - Database Integration\n45:00 - Authentication\n1:05:00 - Deployment\n\n🔗 RESOURCES:\n- GitHub Repo: [link]\n- NestJS Docs: https://nestjs.com\n\n👍 Like this video if you found it helpful!\n🔔 Subscribe for more backend development tutorials!\n\n#NestJS #PostgreSQL #TypeScript #API #WebDevelopment",
  "tags": [
    "nestjs tutorial",
    "rest api",
    "postgresql",
    "typescript",
    "backend development",
    "nodejs",
    "jwt authentication",
    "api development",
    "web development",
    "programming tutorial",
    "nestjs postgresql",
    "nestjs typescript",
    "build rest api"
  ]
}
```

---

### 8. Generate Thread

Generate a Twitter/Threads thread from a topic.

**Endpoint:** `POST /ai/generate/thread`

**Use Case:** Create engaging multi-post threads that tell a story or share detailed information.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| topic | string | Yes | Topic for the thread (3-500 chars) |
| platform | string | Yes | Either "twitter" or "threads" |
| postCount | number | No | Number of posts in the thread (2-25, default: 5) |

**Example Request:**
```json
{
  "topic": "5 mistakes I made in my first year as a freelance developer",
  "platform": "twitter",
  "postCount": 6
}
```

**Example Response:**
```json
{
  "posts": [
    "I made every mistake possible in my first year as a freelance developer. Here are 5 lessons I learned the hard way (so you don't have to) 🧵👇",
    "Mistake #1: Underpricing my services I charged $25/hour because I was scared to lose clients. Result? I attracted price-shopping clients who demanded the most work. When I raised to $75/hour, I got BETTER clients who respected my time.",
    "Mistake #2: No contract = no protection I did a $3,000 project on a handshake. Client disappeared after delivery. Never saw a dime. Now I use contracts for EVERYTHING, even small projects. Non-negotiable.",
    "Mistake #3: Saying yes to everything Took on a machine learning project when I'm a web developer. Spent 3x the hours, delivered mediocre work, damaged my reputation. Stay in your lane until you're ready to expand.",
    "Mistake #4: Working without a deposit Started work before receiving payment. Got ghosted twice. Now it's 50% upfront, no exceptions. Serious clients never push back on this.",
    "Mistake #5: No boundaries = burnout Answered emails at midnight. Worked weekends. Took 'urgent' calls during dinner. Burned out in 8 months. Set office hours. Communicate them clearly. Protect your time. Your best work comes from a rested mind."
  ]
}
```

---

### 9. Repurpose Content

Transform content from one platform format to another.

**Endpoint:** `POST /ai/repurpose`

**Use Case:** Maximize content ROI by adapting a single piece of content for multiple platforms.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| originalContent | string | Yes | The original content to repurpose (10-5000 chars) |
| sourcePlatform | string | Yes | Platform the content was written for |
| targetPlatform | string | Yes | Platform to adapt the content for |

**Example Request:**
```json
{
  "originalContent": "We're thrilled to announce the launch of our new AI-powered analytics dashboard! After 18 months of development and feedback from over 500 beta users, we've built something truly special.\n\nKey features include:\n- Real-time data visualization\n- Predictive analytics powered by machine learning\n- Custom report builder\n- Team collaboration tools\n- API integrations with 50+ platforms\n\nWe're offering 30% off for early adopters. Visit our website to learn more and start your free trial today.",
  "sourcePlatform": "linkedin",
  "targetPlatform": "twitter"
}
```

**Example Response:**
```json
{
  "content": "We just launched our AI analytics dashboard! 🚀\n\n18 months of work. 500+ beta testers. Finally here.\n\n✨ Real-time visualization\n✨ ML-powered predictions\n✨ 50+ integrations\n\n30% off for early adopters 👀\n\nLink in bio"
}
```

---

### 10. Improve Post

Enhance an existing post to make it more engaging.

**Endpoint:** `POST /ai/improve`

**Use Case:** Polish drafts or underperforming posts to increase engagement.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| originalPost | string | Yes | The post to improve (10-5000 chars) |
| platform | string | Yes | Target platform |
| improvementFocus | string | No | Specific area to focus on (engagement, clarity, professionalism, etc.) |

**Example Request:**
```json
{
  "originalPost": "We have a new product that helps businesses track their sales. It has many features and is very useful. Check it out on our website.",
  "platform": "linkedin",
  "improvementFocus": "make it more engaging and specific"
}
```

**Example Response:**
```json
{
  "content": "Sales teams waste 40% of their time on manual data entry.\n\nWe built something to fix that.\n\nOur new sales tracking platform:\n→ Automates pipeline updates in real-time\n→ Predicts deal close rates with 89% accuracy\n→ Generates reports in seconds, not hours\n\nEarly users are reporting 12+ hours saved per week.\n\nCurious how it works? Drop a comment or visit the link in our bio for a free demo."
}
```

---

### 11. Generate Bio

Generate a social media profile bio.

**Endpoint:** `POST /ai/generate/bio`

**Use Case:** Create compelling profile bios that attract followers and convey your value.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| description | string | Yes | Description of yourself/brand (10-500 chars) |
| platform | string | Yes | Target platform |
| keywords | array | No | Keywords or themes to include |

**Example Request:**
```json
{
  "description": "A full-stack developer who builds SaaS products and teaches coding through tutorials and courses. Based in Austin, Texas.",
  "platform": "twitter",
  "keywords": ["developer", "SaaS", "educator", "indie hacker"]
}
```

**Example Response:**
```json
{
  "content": "Full-stack dev building SaaS products in public 🛠️ | Teaching 50k+ developers through tutorials | Indie hacker | Austin, TX 📍 | DMs open for collabs"
}
```

---

### 12. Translate Content

Translate social media content while maintaining platform-appropriate style.

**Endpoint:** `POST /ai/translate`

**Use Case:** Expand reach to international audiences with localized content.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| content | string | Yes | Content to translate (1-5000 chars) |
| targetLanguage | string | Yes | Target language (e.g., "Spanish", "French", "German") |
| platform | string | No | Platform to optimize for |

**Example Request:**
```json
{
  "content": "Excited to announce our Series A! 🎉 After 2 years of building, we've raised $10M to help more businesses automate their workflows. Thank you to our amazing team and customers who made this possible! #StartupLife #Funding",
  "targetLanguage": "Spanish",
  "platform": "linkedin"
}
```

**Example Response:**
```json
{
  "content": "¡Emocionados de anunciar nuestra Serie A! 🎉 Después de 2 años construyendo, hemos recaudado $10M para ayudar a más empresas a automatizar sus flujos de trabajo. ¡Gracias a nuestro increíble equipo y clientes que hicieron esto posible! #VidaStartup #Financiamiento"
}
```

---

### 13. Generate Variations

Create multiple versions of the same post for A/B testing.

**Endpoint:** `POST /ai/generate/variations`

**Use Case:** Test different messaging approaches to find what resonates best with your audience.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| content | string | Yes | Original post to create variations of (10-5000 chars) |
| platform | string | Yes | Target platform |
| count | number | No | Number of variations (2-10, default: 3) |

**Example Request:**
```json
{
  "content": "Join our free webinar on mastering LinkedIn for B2B sales. Learn proven strategies from top performers. Register now!",
  "platform": "linkedin",
  "count": 3
}
```

**Example Response:**
```json
{
  "variations": [
    "B2B sales on LinkedIn is broken. Most people are doing it wrong.\n\nIn our free webinar, we're revealing the exact playbook top 1% performers use to book 10+ meetings per week.\n\nNo fluff. Just tactics that work.\n\nRegister now (link in comments)",
    "I spent 6 months studying LinkedIn's top B2B salespeople.\n\nTheir strategies are surprisingly simple—but almost nobody uses them.\n\nWe're hosting a free webinar to break it all down.\n\nSpots are limited. Save yours today 👇",
    "Free webinar alert 🎯\n\nTopic: Mastering LinkedIn for B2B Sales\n\nWhat you'll learn:\n→ The messaging framework that gets 40%+ reply rates\n→ How to build a pipeline without being pushy\n→ Automation tools that won't get you banned\n\nRegister: [link]"
  ]
}
```

---

### 14. Analyze Post

Get AI-powered feedback and improvement suggestions for a post.

**Endpoint:** `POST /ai/analyze`

**Use Case:** Get objective feedback on post quality before publishing.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| content | string | Yes | Post to analyze (10-5000 chars) |
| platform | string | Yes | Target platform |

**Example Request:**
```json
{
  "content": "Check out our new product its really good and you should definitely buy it because we worked hard on it and its better than competitors!!!",
  "platform": "linkedin"
}
```

**Example Response:**
```json
{
  "score": 4,
  "strengths": [
    "Shows enthusiasm for the product",
    "Mentions competitive advantage"
  ],
  "improvements": [
    "Too pushy and sales-focused without providing value",
    "No specific benefits or features mentioned",
    "Grammar issues (missing apostrophe, run-on sentence)",
    "Excessive exclamation marks appear unprofessional",
    "No clear call-to-action or next steps"
  ],
  "suggestions": "Rewrite the post to lead with a customer problem you solve, highlight 2-3 specific benefits with proof points, and end with a soft call-to-action. Replace 'really good' and 'better than competitors' with concrete differentiators. Keep the tone confident but professional for LinkedIn's audience."
}
```

---

## Platform-Specific Guidelines

| Platform | Character Limit | Best Practices |
|----------|----------------|----------------|
| Twitter | 280 | Concise, punchy, 2-3 hashtags max |
| LinkedIn | 3,000 | Professional, thought-leadership, 3-5 hashtags |
| Facebook | 63,206 | Conversational, community-focused |
| Instagram | 2,200 | Visual-focused, emoji-friendly, up to 30 hashtags |
| Threads | 500 | Casual, authentic, minimal hashtags |
| Pinterest | 500 | Descriptive, keyword-rich, actionable |
| YouTube | Title: 100, Desc: 5,000 | SEO-optimized, include timestamps |

---

## Error Responses

**400 Bad Request** - Invalid input
```json
{
  "statusCode": 400,
  "message": ["topic must be longer than or equal to 3 characters"],
  "error": "Bad Request"
}
```

**401 Unauthorized** - Missing or invalid JWT token
```json
{
  "statusCode": 401,
  "message": "Unauthorized"
}
```

**400 Bad Request** - AI service not configured
```json
{
  "statusCode": 400,
  "message": "Groq API is not configured"
}
```

---

## Rate Limits

Groq's free tier includes:
- 30 requests per minute
- 14,400 requests per day

For higher limits, upgrade your Groq plan at https://console.groq.com
