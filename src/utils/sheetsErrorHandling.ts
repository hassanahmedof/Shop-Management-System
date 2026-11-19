import { CARE_MART_SPREADSHEET_TITLE } from '../../shared/googleSheetsSchema';

export type SheetsSyncErrorCode =
  | 'policy_enforced'
  | 'popup_closed'
  | 'popup_blocked'
  | 'user_mismatch'
  | 'token_expired'
  | 'token_missing'
  | 'permission_denied'
  | 'not_found'
  | 'rate_limit'
  | 'offline'
  | 'service_account_error'
  | 'server_error';

export interface SheetsErrorResolution {
  code: SheetsSyncErrorCode;
  severity: 'warning' | 'error' | 'info';
  title: string;
  summary: string;
  cause: string;
  steps: string[];
  suggestAlternatives: boolean;
  possiblePolicyBlock: boolean;
  retryable: boolean;
  rawMessage: string;
}

export class SheetsOAuthError extends Error {
  resolution: SheetsErrorResolution;

  constructor(resolution: SheetsErrorResolution) {
    super(resolution.summary);
    this.name = 'SheetsOAuthError';
    this.resolution = resolution;
  }
}

function extractErrorDetails(err: unknown): {
  firebaseCode: string;
  message: string;
  combinedText: string;
} {
  if (err instanceof SheetsOAuthError) {
    return {
      firebaseCode: err.resolution.code,
      message: err.resolution.summary,
      combinedText: `${err.resolution.code} ${err.resolution.rawMessage} ${err.resolution.summary}`.toLowerCase(),
    };
  }

  let firebaseCode = '';
  let message = '';
  let customText = '';

  if (typeof err === 'object' && err !== null) {
    if ('code' in err && typeof (err as { code?: unknown }).code === 'string') {
      firebaseCode = (err as { code: string }).code;
    }
    if ('customData' in err && (err as { customData?: unknown }).customData) {
      try {
        customText = JSON.stringify((err as { customData: unknown }).customData);
      } catch {
        customText = '';
      }
    }
  }

  if (err instanceof Error) {
    message = err.message;
  } else if (typeof err === 'string') {
    message = err;
  }

  const combinedText = `${firebaseCode} ${message} ${customText}`.toLowerCase();
  return { firebaseCode, message, combinedText };
}

export function buildPolicyEnforcedResolution(
  context: 'login' | 'sheets_oauth',
  rawMessage = 'Error 400: policy_enforced'
): SheetsErrorResolution {
  if (context === 'login') {
    return {
      code: 'policy_enforced',
      severity: 'error',
      title: 'Google Policy Blocked OAuth Request (Error 400: policy_enforced)',
      summary:
        'Google Advanced Protection Program or Workspace OAuth policy blocked this sign-in request.',
      cause:
        'Accounts in Google Advanced Protection Program (or restricted Workspace orgs) block third-party OAuth apps that request unapproved sensitive scopes.',
      steps: [
        'Ensure your browser clears any cached OAuth consent prompt and retry "Continue with Google Account" (basic identity scopes only).',
        'If your Google Workspace administrator enforces OAuth App Access Control, approve this OAuth Client ID in Google Admin Console → Security → API Controls.',
        'For automated Google Sheets sync while keeping Advanced Protection enabled, configure a Server Service Account in Settings after signing in.',
      ],
      suggestAlternatives: true,
      possiblePolicyBlock: true,
      retryable: false,
      rawMessage,
    };
  }

  return {
    code: 'policy_enforced',
    severity: 'warning',
    title: 'Google Advanced Protection Blocked Browser OAuth (Error 400: policy_enforced)',
    summary:
      'Your Google account security policy does not allow browser OAuth popups to access Google Sheets directly.',
    cause:
      'Google’s Advanced Protection Program (or Workspace API Control) automatically rejects third-party web OAuth requests for sensitive Drive/Sheets scopes with "Error 400: policy_enforced". Your shop data in Firebase remains 100% safe.',
    steps: [
      'Option A (Recommended): Configure a server-side Google Service Account (GOOGLE_SERVICE_ACCOUNT_JSON) in your server secrets, share your Google Sheet with that Service Account email as Editor, and sync automatically without browser OAuth.',
      'Option B (Instant Local Sync): Click "Export All 14 Tabs (.xlsx)" below to download a complete Excel workbook matching CareMart Shop Manager – Business Records, ready for Excel or manual Google Sheets import.',
      'Option C: Authorize Google Sheets using a standard (non-Advanced Protection) manager Google account if preferred.',
    ],
    suggestAlternatives: true,
    possiblePolicyBlock: true,
    retryable: false,
    rawMessage,
  };
}

export function classifyGoogleAuthError(
  err: unknown,
  context: 'login' | 'sheets_oauth',
  ownerEmail?: string | null
): SheetsErrorResolution {
  if (err instanceof SheetsOAuthError) {
    return err.resolution;
  }

  const { firebaseCode, message, combinedText } = extractErrorDetails(err);

  if (
    combinedText.includes('policy_enforced') ||
    combinedText.includes('admin_policy_enforced') ||
    combinedText.includes('org_internal')
  ) {
    return buildPolicyEnforcedResolution(context, message || firebaseCode || 'policy_enforced');
  }

  if (
    firebaseCode === 'auth/popup-closed-by-user' ||
    firebaseCode === 'auth/cancelled-popup-request'
  ) {
    if (context === 'sheets_oauth') {
      return {
        code: 'popup_closed',
        severity: 'warning',
        title: 'Google Sheets Authorization Window Closed',
        summary:
          'The Google authorization popup closed before granting Google Sheets access. If Google displayed "Error 400: policy_enforced" inside the popup, your account uses Advanced Protection.',
        cause:
          'Either the popup was closed manually, or Google displayed an Error 400: policy_enforced / access blocked screen inside the popup window.',
        steps: [
          'If you closed it accidentally, click "Authorize & Connect Google Sheets" to try again.',
          'If Google showed "Error 400: policy_enforced" (Advanced Protection Program), switch to the Server Service Account setup or download the 14-Tab Excel Workbook (.xlsx) below.',
        ],
        suggestAlternatives: true,
        possiblePolicyBlock: true,
        retryable: true,
        rawMessage: message || firebaseCode,
      };
    }

    return {
      code: 'popup_closed',
      severity: 'info',
      title: 'Sign-In Cancelled',
      summary: 'Google sign-in popup was closed before completing.',
      cause: 'The browser sign-in popup was closed or superseded by another sign-in click.',
      steps: ['Click "Continue with Google Account" again and complete the sign-in flow.'],
      suggestAlternatives: false,
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: message || firebaseCode,
    };
  }

  if (firebaseCode === 'auth/popup-blocked') {
    return {
      code: 'popup_blocked',
      severity: 'warning',
      title: 'Browser Blocked Authorization Pop-up',
      summary: 'Your browser blocked the Google authorization popup window.',
      cause: 'Pop-up blockers or strict iframe privacy settings prevented the Google consent window from opening.',
      steps: [
        'Allow pop-ups for this site in your browser address bar settings and retry.',
        'Alternatively, configure a Server Service Account so background Google Sheets sync works with zero browser pop-ups.',
      ],
      suggestAlternatives: context === 'sheets_oauth',
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: message || firebaseCode,
    };
  }

  if (firebaseCode === 'auth/user-mismatch') {
    return {
      code: 'user_mismatch',
      severity: 'warning',
      title: 'Wrong Google Account Selected',
      summary: ownerEmail
        ? `Please select your authorized Owner Google account (${ownerEmail}) in the popup.`
        : 'Please select your authorized Owner Google account in the popup.',
      cause: 'A different Google account was chosen during the Google Sheets permission prompt.',
      steps: [
        ownerEmail
          ? `Retry and select ${ownerEmail}.`
          : 'Retry and select your Owner/Admin Google account.',
        'If your Owner account uses Advanced Protection (policy_enforced), use the Server Service Account setup instead.',
      ],
      suggestAlternatives: true,
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: message || firebaseCode,
    };
  }

  if (firebaseCode === 'auth/unauthorized-domain') {
    return {
      code: 'server_error',
      severity: 'error',
      title: 'Domain Not Allowlisted in Firebase Auth',
      summary: 'This app URL is not listed under Firebase Console → Authentication → Settings → Authorized domains.',
      cause: 'Firebase Auth restricts OAuth popups to allowlisted hostnames.',
      steps: [
        'Add the current hostname to Authorized domains in Firebase Console → Authentication → Settings.',
      ],
      suggestAlternatives: context === 'sheets_oauth',
      possiblePolicyBlock: false,
      retryable: false,
      rawMessage: message || firebaseCode,
    };
  }

  if (firebaseCode === 'auth/network-request-failed') {
    return {
      code: 'offline',
      severity: 'warning',
      title: 'Network Connection Unavailable',
      summary: 'Unable to reach Google/Firebase authentication servers. Check your internet connection and retry.',
      cause: 'The device appears offline or a firewall/VPN blocked Google OAuth endpoints.',
      steps: [
        'Verify your internet connection and disable conflicting VPN/ad-blockers.',
        'Your business operations continue saving to Firebase offline cache and will sync automatically when online.',
      ],
      suggestAlternatives: context === 'sheets_oauth',
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: message || firebaseCode,
    };
  }

  return {
    code: context === 'sheets_oauth' ? 'token_missing' : 'server_error',
    severity: 'error',
    title: context === 'sheets_oauth' ? 'Google Sheets Authorization Failed' : 'Google Sign-In Failed',
    summary: message || 'Unable to complete Google authorization. Please review options below.',
    cause: firebaseCode ? `Authentication returned code "${firebaseCode}".` : 'Unexpected OAuth response.',
    steps:
      context === 'sheets_oauth'
        ? [
            'Retry "Authorize & Connect Google Sheets" and ensure the spreadsheets permission checkbox is checked.',
            'If blocked by Google policy or Advanced Protection, use a Server Service Account or export the 14-Tab Excel Workbook (.xlsx).',
          ]
        : ['Try signing in again, or check Firebase Authentication Google provider configuration.'],
    suggestAlternatives: context === 'sheets_oauth',
    possiblePolicyBlock: false,
    retryable: true,
    rawMessage: message || firebaseCode || 'unknown_auth_error',
  };
}

export function classifySheetsSyncError(params: {
  code?: string;
  status?: number;
  message?: string;
  serviceAccountConfigured?: boolean;
  serviceAccountEmail?: string | null;
  serviceAccountStatus?: 'active' | 'not_configured' | 'invalid_format';
  serviceAccountDiagnostic?: string | null;
}): SheetsErrorResolution {
  const raw = params.message || '';
  const lower = raw.toLowerCase();
  const code = params.code || '';

  if (
    lower.includes('policy_enforced') ||
    lower.includes('admin_policy_enforced') ||
    lower.includes('advanced protection')
  ) {
    return buildPolicyEnforcedResolution('sheets_oauth', raw);
  }

  if (lower.includes('popup') && lower.includes('closed')) {
    return classifyGoogleAuthError({ code: 'auth/popup-closed-by-user', message: raw }, 'sheets_oauth');
  }

  if (lower.includes('offline') || lower.includes('failed to fetch') || lower.includes('networkerror')) {
    return {
      code: 'offline',
      severity: 'info',
      title: 'Offline — Changes Safely Queued',
      summary:
        'Your device is currently offline. All business records are safely saved locally & queued for automatic Google Sheets sync when connectivity returns.',
      cause: 'Internet connectivity is unavailable or interrupted.',
      steps: [
        'Continue recording sales, purchases, and expenses normally — nothing is lost.',
        'Once online, CareMart automatically flushes all queued worksheets.',
        'Need an offline spreadsheet file right now? Download the 14-Tab Excel Workbook (.xlsx) below.',
      ],
      suggestAlternatives: true,
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: raw,
    };
  }

  if (params.serviceAccountStatus === 'invalid_format' || lower.includes('google_service_account_json')) {
    return {
      code: 'service_account_error',
      severity: 'error',
      title: 'Server Service Account Configuration Invalid',
      summary:
        params.serviceAccountDiagnostic ||
        raw ||
        'GOOGLE_SERVICE_ACCOUNT_JSON on the server could not be parsed.',
      cause: 'The GOOGLE_SERVICE_ACCOUNT_JSON environment secret is malformed or missing client_email / private_key.',
      steps: [
        'Paste the complete unmodified JSON key downloaded from Google Cloud Console → IAM & Admin → Service Accounts into GOOGLE_SERVICE_ACCOUNT_JSON.',
        'Click "Re-check Server Config" below once updated.',
        'Meanwhile, you can still export all 14 business tabs to Excel (.xlsx) below.',
      ],
      suggestAlternatives: true,
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: raw,
    };
  }

  if (code === 'GOOGLE_TOKEN_MISSING' || (!params.serviceAccountConfigured && lower.includes('authorization needed'))) {
    return {
      code: 'token_missing',
      severity: 'warning',
      title: 'Google Sheets Authorization Required',
      summary:
        'Firebase records are saved, and pending rows are queued until Google Sheets authorization is active.',
      cause:
        'Browser OAuth tokens are kept strictly in memory for security (cleared on page reload) and no server Service Account is configured.',
      steps: [
        'Click "Authorize & Connect Google Sheets" to reconnect with your Google account.',
        'If your Google account uses Advanced Protection (Error 400: policy_enforced), configure GOOGLE_SERVICE_ACCOUNT_JSON on the server so sync remains unattended across reloads.',
        'Or export all 14 tabs instantly as an Excel (.xlsx) workbook anytime.',
      ],
      suggestAlternatives: true,
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: raw,
    };
  }

  if (code === 'GOOGLE_TOKEN_EXPIRED' || params.status === 401 || lower.includes('expired')) {
    return {
      code: 'token_expired',
      severity: 'warning',
      title: 'Google Sheets Session Expired',
      summary:
        'Your temporary browser Google OAuth session expired (~1 hour lifetime). Pending updates are safely queued.',
      cause: 'Google browser OAuth access tokens expire after 60 minutes.',
      steps: [
        'Click "Reconnect Google Sheets" to renew your session and push queued records.',
        'For uninterrupted background sync that never expires on page refresh, configure a Server Service Account (GOOGLE_SERVICE_ACCOUNT_JSON).',
      ],
      suggestAlternatives: true,
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: raw,
    };
  }

  if (code === 'GOOGLE_PERMISSION_DENIED' || params.status === 403 || lower.includes('permission')) {
    return {
      code: 'permission_denied',
      severity: 'error',
      title: 'Google Spreadsheet Permission Denied',
      summary: params.serviceAccountConfigured
        ? `The server Service Account does not have Editor access to "${CARE_MART_SPREADSHEET_TITLE}" (or Google Sheets API is not enabled).`
        : 'Google Sheets API rejected the write request due to missing spreadsheet permissions.',
      cause: params.serviceAccountConfigured
        ? 'When using a Service Account with a spreadsheet in your Google Drive, the sheet must be explicitly shared with the Service Account email as Editor, and the Google Sheets API must be enabled in your Google Cloud project.'
        : 'The linked spreadsheet may be view-only, owned by another account, or missing the spreadsheets scope.',
      steps: params.serviceAccountConfigured
        ? [
            params.serviceAccountEmail
              ? `Open your Google Sheet → Share → add "${params.serviceAccountEmail}" as Editor.`
              : 'Open your Google Sheet → Share → add the Service Account email shown below as Editor.',
            'Verify Google Sheets API (sheets.googleapis.com) is enabled in Google Cloud Console for your project.',
            'Click "Retry Queued Sync" after sharing.',
          ]
        : [
            'Verify you own or have Editor permission on the linked spreadsheet.',
            'Click "Reconnect Google Sheets" and approve the spreadsheets permission.',
            'Alternatively, use a Server Service Account or export the 14-Tab Excel Workbook (.xlsx).',
          ],
      suggestAlternatives: true,
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: raw,
    };
  }

  if (code === 'GOOGLE_NOT_FOUND' || params.status === 404 || lower.includes('not found')) {
    return {
      code: 'not_found',
      severity: 'error',
      title: 'Linked Spreadsheet Not Found',
      summary: 'The target Google Spreadsheet could not be found, was trashed, or is not shared with your active credentials.',
      cause: 'The Spreadsheet ID may contain a typo, the file was deleted/moved to trash, or the Service Account has not been granted access (Google returns 404 for unshared files).',
      steps: [
        params.serviceAccountConfigured && params.serviceAccountEmail
          ? `Make sure the sheet is shared as Editor with ${params.serviceAccountEmail}.`
          : 'Check that the spreadsheet still exists in Google Drive.',
        'Paste a valid Google Sheets URL or ID in "Link Existing Google Spreadsheet" or click "Initialize Business Records Spreadsheet" to create a fresh 14-tab sheet.',
      ],
      suggestAlternatives: true,
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: raw,
    };
  }

  if (code === 'GOOGLE_RATE_LIMIT' || params.status === 429 || lower.includes('rate limit')) {
    return {
      code: 'rate_limit',
      severity: 'warning',
      title: 'Google Sheets Rate Limit Reached',
      summary: 'Google Sheets API quota temporarily throttled writes. Automatic backoff retry is scheduled.',
      cause: 'Rapid bursts of multi-tab writes briefly exceeded Google Sheets per-minute write quota.',
      steps: [
        'No action needed — CareMart queued the pending worksheets and will retry automatically.',
        'You can also click "Retry Queued Sync" after 30–60 seconds.',
      ],
      suggestAlternatives: false,
      possiblePolicyBlock: false,
      retryable: true,
      rawMessage: raw,
    };
  }

  return {
    code: 'server_error',
    severity: 'error',
    title: 'Google Sheets Synchronization Error',
    summary: raw || 'An unexpected error occurred while synchronizing with Google Sheets.',
    cause: 'Temporary Google API communication failure or configuration mismatch.',
    steps: [
      'Click "Retry Queued Sync" to push pending Firebase records.',
      'If the problem persists, verify your spreadsheet link or download the 14-Tab Excel Workbook (.xlsx) below.',
    ],
    suggestAlternatives: true,
    possiblePolicyBlock: false,
    retryable: true,
    rawMessage: raw,
  };
}
