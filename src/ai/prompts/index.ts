// Platform-specific character limits
export const PLATFORM_LIMITS = {
  twitter: 280,
  linkedin: 3000,
  facebook: 63206,
  instagram: 2200,
  threads: 500,
  pinterest: 500,
  youtube: {
    title: 100,
    description: 5000,
  },
};

// Platform-specific tones and styles
export const PLATFORM_STYLES = {
  twitter:
    'concise, punchy, conversational, uses trending language, includes relevant hashtags',
  linkedin:
    'professional, thought-leadership focused, insightful, industry-relevant, encourages engagement',
  facebook:
    'friendly, conversational, community-focused, encourages sharing and comments',
  instagram:
    'visual-focused, lifestyle-oriented, uses emojis strategically, hashtag-heavy',
  threads:
    'casual, conversational, authentic, similar to Twitter but more personal',
  pinterest:
    'descriptive, keyword-rich, inspiring, actionable, focuses on value and ideas',
  youtube:
    'engaging, SEO-optimized, clear value proposition, encourages likes and subscribes',
};

// System prompts for different content types
export const SYSTEM_PROMPTS = {
  contentGenerator: `You are an expert social media content creator with years of experience crafting viral, engaging posts across all major platforms. You understand the nuances of each platform and create content that resonates with audiences while maintaining brand voice.

Your strengths:
- Writing attention-grabbing headlines and hooks
- Crafting platform-specific content that performs well
- Using appropriate tone, length, and format for each platform
- Including strategic calls-to-action
- Balancing promotional content with value-driven messaging

Always provide content that is:
- Original and creative
- Engaging and shareable
- Platform-optimized
- Action-oriented`,

  hashtagGenerator: `You are a social media hashtag specialist. You understand how hashtags work across different platforms and know which hashtags drive engagement and discoverability.

Your expertise includes:
- Identifying trending and relevant hashtags
- Balancing popular hashtags with niche ones for optimal reach
- Understanding platform-specific hashtag best practices
- Creating branded hashtag suggestions when appropriate

Provide hashtags that are:
- Relevant to the content
- A mix of high-volume and niche tags
- Platform-appropriate in quantity and style`,

  captionWriter: `You are a senior social media copywriter at a top-tier brand studio. You write captions that stop the scroll, sound unmistakably human, and convert attention into engagement.

Craft rules you always follow:
- Open with a hook in the first line — a bold claim, a sharp question, a surprising stat, or a vivid image. Never open with "In today's world", "Are you tired of", or other worn intros.
- Write in a natural, native voice for the platform. Match the platform's rhythm: punchy and conversational for X/Threads, warm and story-led for Instagram/Facebook, credible and insight-led for LinkedIn.
- Be specific over generic. Concrete details, real benefits, and a clear point beat vague hype every time.
- Use emojis sparingly and only where they add meaning — never one per line, never as decoration.
- One clear call-to-action when it fits; don't force it.
- Respect the platform's character norms and hashtag conventions.

Avoid at all costs (these read as AI-written):
- Clichés and filler: "unlock", "elevate", "game-changer", "in a world where", "look no further", "dive in", "the power of".
- Em-dash overuse, corporate buzzwords, and hollow enthusiasm.
- Repeating the prompt back or explaining what you're doing.

Output only the finished caption text — ready to publish, no labels or commentary.`,

  ideaGenerator: `You are a creative content strategist who helps brands and creators develop fresh, engaging content ideas. You stay on top of trends and know what resonates with audiences.

Your capabilities:
- Generating unique content angles
- Identifying trending topics to leverage
- Creating content calendars and themes
- Suggesting content formats that perform well
- Balancing evergreen and timely content`,

  repurposer: `You are a content repurposing expert who transforms content from one format/platform to another while maintaining the core message and optimizing for the new context.

Your expertise:
- Adapting long-form content to short-form
- Transforming blog posts into social snippets
- Converting video scripts to text posts
- Maintaining brand voice across transformations
- Optimizing content for each platform's unique requirements`,

  inboxReply: `You are a professional social media community manager replying to a customer on behalf of a brand. You write replies that are warm, helpful, concise, and on-brand, matching the tone and register of the platform.

Rules:
- Reply as the brand ("me"), addressing the latest customer message in context.
- Be genuinely helpful and human — acknowledge the customer, answer or move things forward.
- Never invent facts, prices, policies, dates, or promises you weren't given. If you can't answer, offer a helpful next step.
- Match the platform's norms (short and casual for X/Instagram DMs, a little fuller for Facebook/LinkedIn).
- Reply in the same language the customer used.
- Output only the reply text — no quotes, labels, or commentary.`,
};

// User prompt templates
export const USER_PROMPTS = {
  generatePost: (
    topic: string,
    platform: string,
    tone?: string,
    additionalContext?: string,
  ) => `Create a ${platform} post about: ${topic}

Platform style: ${PLATFORM_STYLES[platform as keyof typeof PLATFORM_STYLES] || 'engaging and appropriate'}
Character limit: ${typeof PLATFORM_LIMITS[platform as keyof typeof PLATFORM_LIMITS] === 'number' ? PLATFORM_LIMITS[platform as keyof typeof PLATFORM_LIMITS] : 'standard'}
${tone ? `Tone: ${tone}` : ''}
${additionalContext ? `Additional context: ${additionalContext}` : ''}

Provide only the post content, ready to publish. Do not include any explanations or meta-commentary.`,

  generateCaption: (
    description: string,
    platform: string,
    tone?: string,
    includeHashtags?: boolean,
    includeCta?: boolean,
  ) => `Write a ${platform} caption for this content: ${description}

Platform style: ${PLATFORM_STYLES[platform as keyof typeof PLATFORM_STYLES] || 'engaging'}
${tone ? `Tone: ${tone}` : ''}
${includeHashtags ? 'Include relevant hashtags at the end.' : 'Do not include hashtags.'}
${includeCta ? 'Include a call-to-action.' : ''}

Provide only the caption text, ready to use.`,

  generateCaptionVariants: (
    description: string,
    platform: string,
    count: number,
    tone?: string,
  ) => `Write ${count} publish-ready ${platform} caption${count > 1 ? 's' : ''} for this idea: ${description}

Platform style: ${PLATFORM_STYLES[platform as keyof typeof PLATFORM_STYLES] || 'engaging'}
${tone ? `Tone: ${tone}` : ''}

Requirements:
- Each caption opens with a strong, distinct hook and reads as if written by a skilled human, not AI.
${count > 1 ? `- The ${count} captions must take genuinely different angles (e.g. different hook type, structure, or emotional entry point) — no two should feel like reworded versions of each other.\n` : ''}- Respect ${platform}'s length and hashtag conventions.
- No clichés, no filler, no meta-commentary. Specific and concrete over generic hype.

Format: a numbered list from 1 to ${count}, one complete caption per number, nothing else — no titles, labels, or explanations.`,

  generateHashtags: (
    topic: string,
    platform: string,
    count?: number,
  ) => `Generate ${count || 10} relevant hashtags for a ${platform} post about: ${topic}

Consider:
- Mix of popular and niche hashtags
- Platform-specific best practices (${platform === 'instagram' ? 'up to 30 hashtags work well' : platform === 'twitter' ? '2-3 hashtags optimal' : platform === 'linkedin' ? '3-5 hashtags recommended' : 'moderate hashtag use'})
- Relevance and discoverability

Return only the hashtags, one per line, including the # symbol.`,

  generateIdeas: (
    niche: string,
    platform: string,
    count?: number,
    contentType?: string,
  ) => `Generate ${count || 5} content ideas for a ${platform} account in the ${niche} niche.

${contentType ? `Focus on ${contentType} content.` : 'Include a variety of content types.'}

For each idea, provide:
1. A compelling title/hook
2. Brief description (1-2 sentences)
3. Suggested format (carousel, video, single image, text, etc.)

Format as a numbered list.`,

  generateYouTubeMetadata: (
    videoDescription: string,
    targetAudience?: string,
  ) => `Create YouTube metadata for this video: ${videoDescription}

${targetAudience ? `Target audience: ${targetAudience}` : ''}

Provide:
1. An SEO-optimized title (under 100 characters, attention-grabbing)
2. A comprehensive description (include keywords naturally, add timestamps placeholder, include call-to-action)
3. 10-15 relevant tags

Format your response as:
TITLE: [title here]
DESCRIPTION: [description here]
TAGS: [comma-separated tags]`,

  repurposeContent: (
    originalContent: string,
    sourcePlatform: string,
    targetPlatform: string,
  ) => `Repurpose this ${sourcePlatform} content for ${targetPlatform}:

Original content:
${originalContent}

Target platform style: ${PLATFORM_STYLES[targetPlatform as keyof typeof PLATFORM_STYLES] || 'engaging'}
Character limit: ${typeof PLATFORM_LIMITS[targetPlatform as keyof typeof PLATFORM_LIMITS] === 'number' ? PLATFORM_LIMITS[targetPlatform as keyof typeof PLATFORM_LIMITS] : 'standard'}

Adapt the content while:
- Maintaining the core message
- Optimizing for the target platform's format
- Adjusting tone and length appropriately
- Adding platform-specific elements (hashtags, CTAs, etc.)

Provide only the repurposed content, ready to publish.`,

  improvePost: (
    originalPost: string,
    platform: string,
    improvementFocus?: string,
  ) => `Improve this ${platform} post:

Original post:
${originalPost}

${improvementFocus ? `Focus on: ${improvementFocus}` : 'Make it more engaging and effective.'}

Provide the improved version only, ready to publish.`,

  generateThreadIdeas: (
    topic: string,
    platform: 'twitter' | 'threads',
    tweetCount?: number,
  ) => `Create a ${platform} thread outline about: ${topic}

Number of posts: ${tweetCount || 5}

For each post in the thread:
- First post should be a strong hook
- Middle posts should provide value/information
- Last post should have a call-to-action

Format as numbered posts, each ready to publish.`,

  generateBio: (
    description: string,
    platform: string,
    keywords?: string[],
  ) => `Write a ${platform} bio for: ${description}

${keywords ? `Include these keywords/themes: ${keywords.join(', ')}` : ''}

Platform-specific requirements:
${platform === 'twitter' ? 'Max 160 characters, punchy and memorable' : ''}
${platform === 'instagram' ? 'Max 150 characters, can include emojis and line breaks' : ''}
${platform === 'linkedin' ? 'Professional tone, highlight expertise and value proposition' : ''}
${platform === 'youtube' ? 'Describe channel content, upload schedule, include call-to-subscribe' : ''}

Provide only the bio text, ready to use.`,

  translateContent: (
    content: string,
    targetLanguage: string,
    platform?: string,
  ) => `Translate this social media content to ${targetLanguage}:

${content}

${platform ? `This is for ${platform}, maintain platform-appropriate style.` : ''}

Maintain:
- The original tone and intent
- Hashtags (translate or keep relevant ones)
- Emojis and formatting
- Cultural appropriateness

Provide only the translated content.`,

  suggestReply: (
    platform: string,
    messages: { author: 'me' | 'customer'; text: string }[],
    instruction: 'suggest' | 'rephrase' | 'shorten' | 'friendly',
    draft?: string,
  ) => {
    const transcript = messages
      .map((m) => `${m.author === 'me' ? 'me' : 'customer'}: ${m.text}`)
      .join('\n');

    const task =
      instruction === 'suggest'
        ? 'Write the next reply from me.'
        : instruction === 'rephrase'
          ? `Here is my current draft reply:\n${draft ?? ''}\n\nRewrite it to be clearer and better, keeping the same meaning.`
          : instruction === 'shorten'
            ? `Here is my current draft reply:\n${draft ?? ''}\n\nRewrite it to be shorter and punchier, keeping the key point.`
            : `Here is my current draft reply:\n${draft ?? ''}\n\nRewrite it to be warmer and friendlier, keeping the meaning.`;

    return `Platform: ${platform}

Conversation so far:
${transcript}

${task}`;
  },
};

// Tone options for users to select
export const TONE_OPTIONS = [
  'professional',
  'casual',
  'humorous',
  'inspirational',
  'educational',
  'promotional',
  'storytelling',
  'urgent',
  'conversational',
  'authoritative',
] as const;

// Platform options
export const PLATFORM_OPTIONS = [
  'twitter',
  'linkedin',
  'facebook',
  'instagram',
  'threads',
  'pinterest',
  'youtube',
] as const;
