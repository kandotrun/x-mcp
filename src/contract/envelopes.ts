/**
 * Output contract: zod schemas for every result envelope. Tests parse real tool output with these strict
 * schemas; the runtime only imports the inferred types.
 */
import * as z from 'zod/v4';

const isoTime = z.string();

export const AuthorSchema = z.strictObject({
  handle: z.string(),
  name: z.string().optional(),
  verified: z.literal(true).optional()
});

export const MetricsSchema = z.strictObject({
  replies: z.number().optional(),
  reposts: z.number().optional(),
  quotes: z.number().optional(),
  likes: z.number().optional(),
  bookmarks: z.number().optional(),
  views: z.number().optional()
});

export const MediaSchema = z.strictObject({
  type: z.enum(['photo', 'video', 'gif', 'external']),
  url: z.string(),
  alt: z.string().optional(),
  thumbnail_url: z.string().optional(),
  duration_s: z.number().optional()
});

export const UnavailableSchema = z.strictObject({
  id: z.string().optional(),
  url: z.string().optional(),
  unavailable: z.string()
});

export const QuoteSchema = z.union([
  z.strictObject({
    id: z.string(),
    url: z.string().optional(),
    author: z.string().optional(),
    created_at: isoTime.optional(),
    text: z.string(),
    text_truncated: z.literal(true).optional()
  }),
  UnavailableSchema
]);

export const PostSchema = z.strictObject({
  id: z.string(),
  url: z.string().optional(),
  created_at: isoTime.optional(),
  author: AuthorSchema.optional(),
  reposted_by: z.string().optional(),
  reply_to: z.strictObject({ handle: z.string(), post_id: z.string().optional() }).optional(),
  text: z.string(),
  text_truncated: z.literal(true).optional(),
  lang: z.string().optional(),
  metrics: MetricsSchema.optional(),
  quote: QuoteSchema.optional(),
  media: z.array(MediaSchema).optional(),
  card: z.strictObject({ url: z.string(), title: z.string().optional() }).optional(),
  poll: z
    .strictObject({
      choices: z.array(
        z.strictObject({ label: z.string(), votes: z.number().optional(), percent: z.number().optional() })
      ),
      total_votes: z.number().optional(),
      ends_at: z.string().optional()
    })
    .optional(),
  article: z
    .strictObject({
      title: z.string().optional(),
      preview_text: z.string().optional(),
      text: z.string().optional(),
      text_truncated: z.literal(true).optional()
    })
    .optional(),
  community_note: z.string().optional(),
  possibly_sensitive: z.literal(true).optional()
});

export const PostItemSchema = z.union([PostSchema, UnavailableSchema]);

export const AboutSchema = z.strictObject({
  based_in: z.string().optional(),
  location_accurate: z.boolean().optional(),
  created_country_accurate: z.boolean().optional(),
  source: z.string().optional(),
  username_changes: z.number().optional(),
  username_last_changed_at: isoTime.optional()
});

export const UserSchema = z.strictObject({
  handle: z.string(),
  name: z.string().optional(),
  id: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  website: z.string().optional(),
  joined: isoTime.optional(),
  followers: z.number().optional(),
  following: z.number().optional(),
  posts: z.number().optional(),
  likes: z.number().optional(),
  media_count: z.number().optional(),
  verified: z.literal(true).optional(),
  verified_type: z.string().optional(),
  protected: z.literal(true).optional(),
  about: AboutSchema.optional()
});

export const TypeaheadUserSchema = z.strictObject({
  handle: z.string(),
  name: z.string().optional(),
  verified: z.literal(true).optional(),
  followers: z.number().optional()
});

export const TrendSchema = z.strictObject({
  name: z.string(),
  context: z.string().optional(),
  rank: z.number().optional()
});

const listFields = {
  returned: z.number().int().min(0),
  has_more: z.boolean(),
  next_cursor: z.string().optional(),
  truncated: z.literal(true).optional(),
  note: z.string().optional()
};

export const PostListSchema = z.strictObject({ posts: z.array(PostItemSchema), ...listFields });
export const UserListSchema = z.strictObject({ users: z.array(UserSchema), ...listFields });

export const PostResultSchema = z.strictObject({ post: PostSchema, note: z.string().optional() });
export const UserResultSchema = z.strictObject({ user: UserSchema, note: z.string().optional() });
export const TrendsResultSchema = z.strictObject({
  trends: z.array(TrendSchema),
  returned: z.number().int().min(0),
  note: z.string().optional()
});
export const TypeaheadResultSchema = z.strictObject({
  users: z.array(TypeaheadUserSchema),
  topics: z.array(z.string()),
  note: z.string().optional()
});

export const ErrorPayloadSchema = z.strictObject({
  error: z.string(),
  code: z.enum([
    'invalid_argument',
    'invalid_cursor',
    'not_found',
    'restricted',
    'feature_unavailable',
    'rate_limited',
    'timeout',
    'upstream_unavailable',
    'internal'
  ]),
  retryable: z.boolean(),
  hint: z.string(),
  retry_after_seconds: z.number().int().optional(),
  upstream_status: z.number().int().optional()
});

export type Post = z.infer<typeof PostSchema>;
export type Unavailable = z.infer<typeof UnavailableSchema>;
export type PostItem = Post | Unavailable;
export type Media = z.infer<typeof MediaSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type User = z.infer<typeof UserSchema>;
export type About = z.infer<typeof AboutSchema>;
export type TypeaheadUser = z.infer<typeof TypeaheadUserSchema>;
export type Trend = z.infer<typeof TrendSchema>;
