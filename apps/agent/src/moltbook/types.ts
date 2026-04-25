// Registration
export interface MoltbookRegistrationResult {
  api_key: string;
  claim_url: string;
  verification_code: string;
}
export interface MoltbookRegistrationResponse {
  agent: MoltbookRegistrationResult;
}

// Profile
export interface MoltbookProfile {
  name: string;
  description: string;
  karma: number;
  follower_count: number;
  following_count: number;
  posts_count: number;
  is_claimed: boolean;
  created_at: string;
  last_active: string;
}

// Post — author and submolt are nested objects in the real API
export interface MoltbookPostAuthor {
  name: string;
}
export interface MoltbookPostSubmolt {
  name: string;
  display_name?: string;
}
export interface MoltbookPost {
  id: string;
  title: string;
  content?: string;
  url?: string;
  type: string;
  upvotes: number;
  downvotes: number;
  comment_count: number;
  created_at: string;
  author: MoltbookPostAuthor | string;
  submolt: MoltbookPostSubmolt | string;
  verification_status?: string;
}

// Verification challenge
export interface MoltbookVerificationChallenge {
  verification_code: string;
  challenge_text: string;
  expires_at: string;
  instructions: string;
}

// Post creation response
export interface MoltbookPostResponse {
  success: boolean;
  message?: string;
  post: MoltbookPost;
  verification_required?: boolean;
  verification?: MoltbookVerificationChallenge;
}

// Comment
export interface MoltbookComment {
  id: string;
  content: string;
  upvotes: number;
  created_at: string;
  author: MoltbookPostAuthor | string;
  parent_id?: string;
  replies?: MoltbookComment[];
  post_id?: string;
}

// Comment creation response
export interface MoltbookCommentResponse {
  success: boolean;
  comment: MoltbookComment;
  verification_required?: boolean;
  verification?: MoltbookVerificationChallenge;
}

// Submolt
export interface MoltbookSubmolt {
  name: string;
  display_name: string;
  description: string;
  subscriber_count: number;
  allow_crypto: boolean;
}

// Search result
export interface MoltbookSearchResult {
  id: string;
  type: 'post' | 'comment';
  title?: string;
  content?: string;
  upvotes: number;
  similarity: number;
  created_at: string;
  author: MoltbookPostAuthor | string;
  post_id: string;
}

// Feed response
export interface MoltbookFeedResponse {
  posts: MoltbookPost[];
  has_more: boolean;
  next_cursor?: string;
}

// Status
export interface MoltbookStatusResponse {
  status: 'pending_claim' | 'claimed';
}

// Home dashboard
export interface MoltbookHomeActivityItem {
  post_id: string;
  post_title: string;
  submolt_name: string;
  new_notification_count: number;
  latest_at: string;
  latest_commenters: string[];
  preview: string;
}
export interface MoltbookHomeAccount {
  name: string;
  karma: number;
  unread_notification_count: number;
}
export interface MoltbookHomeResponse {
  your_account: MoltbookHomeAccount;
  activity_on_your_posts: MoltbookHomeActivityItem[];
  what_to_do_next: string[];
  your_direct_messages?: {
    unread_message_count: number;
    pending_request_count: number;
  };
}

// Verify response
export interface MoltbookVerifyResponse {
  success: boolean;
  message?: string;
  error?: string;
  content_type?: string;
  content_id?: string;
}

// Rate limit error shape from API
export interface MoltbookRateLimitResponse {
  statusCode: number;
  message: string;
  remaining: number;
  reset_at: string;
  retry_after_seconds?: number;
  retry_after_minutes?: number;
}
