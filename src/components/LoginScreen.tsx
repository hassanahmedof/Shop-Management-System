import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  ShieldCheck,
  Store,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

type LoginTab = 'owner' | 'staff';
type OwnerMode = 'signin' | 'setup';

export function LoginScreen() {
  const {
    ownerSetupCompleted,
    signInOwnerWithEmail,
    setupInitialAdmin,
    sendAdminPasswordReset,
    recoverOwnerWithGoogle,
    signInAsStaff,
    authError,
    authErrorCode,
    authErrorResolution,
    clearAuthError,
    loading,
  } = useAuth();

  const [activeTab, setActiveTab] = useState<LoginTab>('owner');
  const [ownerMode, setOwnerMode] = useState<OwnerMode>('signin');

  // Owner fields
  const [ownerShopName, setOwnerShopName] = useState('CareMart Hygiene & Baby Care');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [ownerConfirmPassword, setOwnerConfirmPassword] = useState('');
  const [showOwnerPassword, setShowOwnerPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [sendingReset, setSendingReset] = useState(false);
  const [showRecoveryPanel, setShowRecoveryPanel] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [recoveringGoogle, setRecoveringGoogle] = useState(false);

  // Staff fields
  const [username, setUsername] = useState('');
  const [staffPassword, setStaffPassword] = useState('');
  const [showStaffPassword, setShowStaffPassword] = useState(false);

  const [submittingOwner, setSubmittingOwner] = useState(false);
  const [submittingStaff, setSubmittingStaff] = useState(false);

  useEffect(() => {
    if (ownerSetupCompleted === false) {
      setOwnerMode('setup');
    } else if (ownerSetupCompleted === true) {
      setOwnerMode('signin');
    }
  }, [ownerSetupCompleted]);

  const handleTabChange = (tab: LoginTab) => {
    if (tab !== activeTab) {
      clearAuthError();
      setLocalError(null);
      setResetNotice(null);
      setActiveTab(tab);
    }
  };

  const switchOwnerMode = (mode: OwnerMode) => {
    clearAuthError();
    setLocalError(null);
    setResetNotice(null);
    setOwnerMode(mode);
  };

  const handleOwnerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAuthError();
    setLocalError(null);
    setResetNotice(null);

    if (ownerMode === 'setup' && ownerSetupCompleted !== true) {
      if (ownerPassword.length < 6) {
        setLocalError('Password must be at least 6 characters.');
        return;
      }
      if (ownerPassword !== ownerConfirmPassword) {
        setLocalError('Passwords do not match.');
        return;
      }

      setSubmittingOwner(true);
      try {
        await setupInitialAdmin({
          displayName: ownerName,
          shopName: ownerShopName,
          email: ownerEmail,
          password: ownerPassword,
        });
      } catch {
        // Error surfaced via authError in AuthContext
      } finally {
        setSubmittingOwner(false);
      }
      return;
    }

    setSubmittingOwner(true);
    try {
      await signInOwnerWithEmail(ownerEmail, ownerPassword);
    } catch {
      // Error surfaced via authError in AuthContext
    } finally {
      setSubmittingOwner(false);
    }
  };

  const handleSendPasswordReset = async () => {
    setLocalError(null);
    setResetNotice(null);
    const targetEmail = (recoveryEmail.trim() || (ownerEmail.includes('@') ? ownerEmail.trim() : '')).toLowerCase();
    if (!targetEmail || !targetEmail.includes('@')) {
      setShowRecoveryPanel(true);
      setLocalError('Enter your Owner email address in the recovery box below, then click "Send Password Setup Link".');
      return;
    }
    setSendingReset(true);
    try {
      await sendAdminPasswordReset(targetEmail);
      clearAuthError();
      setResetNotice(
        `Password setup / reset email sent to ${targetEmail}. Open the link in your inbox (or Spam folder) to set a password, then sign in above.`
      );
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Unable to send password reset email. Check the email address and try again.'
      );
    } finally {
      setSendingReset(false);
    }
  };

  const handleGoogleRecovery = async () => {
    clearAuthError();
    setLocalError(null);
    setResetNotice(null);
    setRecoveringGoogle(true);
    try {
      await recoverOwnerWithGoogle();
    } catch {
      // Error surfaced via authError in AuthContext
    } finally {
      setRecoveringGoogle(false);
    }
  };

  const handleStaffSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setResetNotice(null);
    setSubmittingStaff(true);
    try {
      await signInAsStaff(username, staffPassword);
    } catch {
      // Error surfaced via authError in AuthContext
    } finally {
      setSubmittingStaff(false);
    }
  };

  const visibleError = localError || authError;
  const showSetupForm = ownerMode === 'setup' && ownerSetupCompleted !== true;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-3.5 sm:p-6">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-5 sm:p-7 space-y-4 sm:space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-teal-600 text-white flex items-center justify-center shrink-0">
            <Store className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight font-display truncate">
              CareMart Shop Manager
            </h1>
            <p className="text-xs sm:text-sm text-slate-500">Baby Care, Hygiene &amp; Personal Care Retail</p>
          </div>
        </div>

        {/* Role Login Switcher */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
          <button
            type="button"
            disabled={submittingOwner || submittingStaff}
            onClick={() => handleTabChange('owner')}
            className={`flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer disabled:opacity-60 ${
              activeTab === 'owner'
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 text-teal-600" />
            <span>Owner / Admin</span>
          </button>
          <button
            type="button"
            disabled={submittingOwner || submittingStaff}
            onClick={() => handleTabChange('staff')}
            className={`flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer disabled:opacity-60 ${
              activeTab === 'staff'
                ? 'bg-white text-slate-900 border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <UserCheck className="w-3.5 h-3.5 text-teal-600" />
            <span>Sales Staff</span>
          </button>
        </div>

        {resetNotice && (
          <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{resetNotice}</p>
          </div>
        )}

        {visibleError && (
          <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 space-y-2 break-words">
            <div className="font-semibold text-sm text-red-900">
              {authErrorResolution?.title || 'Authentication Notice'}
            </div>
            <p className="leading-relaxed">{visibleError}</p>
            {authErrorResolution && authErrorResolution.steps.length > 0 && (
              <ul className="list-disc pl-4 space-y-1 text-red-900/90">
                {authErrorResolution.steps.map((step, idx) => (
                  <li key={idx}>{step}</li>
                ))}
              </ul>
            )}
            {activeTab === 'owner' && authErrorCode === 'auth/email-already-in-use' && (
              <div className="pt-1 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => switchOwnerMode('signin')}
                  className="px-2.5 py-1.5 bg-white border border-red-200 hover:bg-red-100 text-red-900 font-semibold rounded-md text-xs cursor-pointer"
                >
                  Switch to Sign In
                </button>
                <button
                  type="button"
                  disabled={sendingReset}
                  onClick={() => void handleSendPasswordReset()}
                  className="px-2.5 py-1.5 bg-red-700 hover:bg-red-800 text-white font-semibold rounded-md text-xs cursor-pointer disabled:opacity-60"
                >
                  {sendingReset ? 'Sending Link...' : 'Send Password Setup Link'}
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'owner' ? (
          <form onSubmit={handleOwnerSubmit} className="space-y-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-slate-900">
                  {showSetupForm ? 'Initial Admin Setup' : 'Owner / Admin Sign In'}
                </h2>
                {ownerSetupCompleted === false && (
                  <button
                    type="button"
                    onClick={() => switchOwnerMode(showSetupForm ? 'signin' : 'setup')}
                    className="text-xs font-semibold text-teal-700 hover:text-teal-800 cursor-pointer"
                  >
                    {showSetupForm ? 'Already have an account? Sign In' : 'First-time Setup'}
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                {showSetupForm
                  ? 'Create the primary Owner/Admin account once to unlock your shop workspace and staff/admin management.'
                  : 'Sign in with your Admin username or Owner email and password to manage inventory, sales, profits, and team accounts.'}
              </p>
            </div>

            {showSetupForm && (
              <>
                <div>
                  <label htmlFor="owner-shop-name" className="block text-xs font-medium text-slate-700 mb-1">
                    Shop Name
                  </label>
                  <input
                    id="owner-shop-name"
                    type="text"
                    required
                    value={ownerShopName}
                    onChange={(e) => setOwnerShopName(e.target.value)}
                    placeholder="e.g. CareMart Hygiene & Baby Care"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
                  />
                </div>
                <div>
                  <label htmlFor="owner-name" className="block text-xs font-medium text-slate-700 mb-1">
                    Owner Full Name
                  </label>
                  <input
                    id="owner-name"
                    type="text"
                    required
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    placeholder="e.g. Hassan Ahmed"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
                  />
                </div>
              </>
            )}

            <div>
              <label htmlFor="owner-email" className="block text-xs font-medium text-slate-700 mb-1">
                {showSetupForm ? 'Owner Email' : 'Admin Username or Owner Email'}
              </label>
              <input
                id="owner-email"
                type={showSetupForm ? 'email' : 'text'}
                required
                autoComplete={showSetupForm ? 'email' : 'username'}
                placeholder={showSetupForm ? 'owner@yourshop.com' : 'e.g. admin_hassan or owner@yourshop.com'}
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
              />
            </div>

            <div>
              <label htmlFor="owner-password" className="block text-xs font-medium text-slate-700 mb-1">
                Password
              </label>
              <div className="relative">
                <input
                  id="owner-password"
                  type={showOwnerPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  autoComplete={showSetupForm ? 'new-password' : 'current-password'}
                  placeholder={showSetupForm ? 'Create a strong password (min 6 chars)' : 'Enter your password'}
                  value={ownerPassword}
                  onChange={(e) => setOwnerPassword(e.target.value)}
                  className="w-full pl-3 pr-10 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
                />
                <button
                  type="button"
                  onClick={() => setShowOwnerPassword((p) => !p)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                  aria-label={showOwnerPassword ? 'Hide password' : 'Show password'}
                >
                  {showOwnerPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {showSetupForm && (
              <div>
                <label htmlFor="owner-confirm-password" className="block text-xs font-medium text-slate-700 mb-1">
                  Confirm Password
                </label>
                <input
                  id="owner-confirm-password"
                  type={showOwnerPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  placeholder="Re-enter your password"
                  value={ownerConfirmPassword}
                  onChange={(e) => setOwnerConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading || submittingOwner || submittingStaff || recoveringGoogle}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
            >
              {showSetupForm ? <UserPlus className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />}
              {submittingOwner
                ? showSetupForm
                  ? 'Creating Admin Account...'
                  : 'Signing In...'
                : showSetupForm
                ? 'Create Admin Account & Open Shop'
                : 'Sign In as Owner / Admin'}
            </button>

            {!showSetupForm && (
              <div className="space-y-3 pt-1">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => {
                      setShowRecoveryPanel((v) => !v);
                      if (!recoveryEmail && ownerEmail.includes('@')) {
                        setRecoveryEmail(ownerEmail);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-700 hover:text-teal-800 cursor-pointer"
                  >
                    <Mail className="w-3.5 h-3.5" />
                    <span>Don&apos;t know your password? Set / Recover Access</span>
                  </button>
                </div>

                {showRecoveryPanel && (
                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3 text-xs">
                    <p className="text-slate-600 leading-relaxed">
                      If you originally opened this shop with Google and never set a password, enter your Owner email to receive a one-click password setup link:
                    </p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="email"
                        value={recoveryEmail}
                        onChange={(e) => setRecoveryEmail(e.target.value)}
                        placeholder="Owner email (e.g. name@gmail.com)"
                        className="flex-1 min-w-0 min-h-[40px] px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-teal-600"
                      />
                      <button
                        type="button"
                        disabled={sendingReset}
                        onClick={() => void handleSendPasswordReset()}
                        className="min-h-[40px] px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-md whitespace-nowrap cursor-pointer disabled:opacity-60"
                      >
                        {sendingReset ? 'Sending...' : 'Send Setup Link'}
                      </button>
                    </div>
                    <div className="pt-2 border-t border-slate-200 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-slate-500">
                        Or unlock in a standalone tab using Google:
                      </span>
                      <button
                        type="button"
                        disabled={recoveringGoogle}
                        onClick={() => void handleGoogleRecovery()}
                        className="px-2.5 py-1 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 font-semibold rounded-md text-[11px] whitespace-nowrap cursor-pointer disabled:opacity-60"
                      >
                        {recoveringGoogle ? 'Opening...' : 'Google Recovery'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </form>
        ) : (
          <form onSubmit={handleStaffSubmit} className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-slate-900">Sales Staff Sign In</h2>
              <p className="text-xs text-slate-500">
                Enter the username and password assigned by your shop owner.
              </p>
            </div>

            <div>
              <label htmlFor="staff-username" className="block text-xs font-medium text-slate-700 mb-1">
                Username
              </label>
              <input
                id="staff-username"
                type="text"
                required
                autoComplete="username"
                placeholder="e.g. ali_sales"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
              />
            </div>

            <div>
              <label htmlFor="staff-password" className="block text-xs font-medium text-slate-700 mb-1">
                Password
              </label>
              <div className="relative">
                <input
                  id="staff-password"
                  type={showStaffPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={staffPassword}
                  onChange={(e) => setStaffPassword(e.target.value)}
                  className="w-full pl-3 pr-10 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
                />
                <button
                  type="button"
                  onClick={() => setShowStaffPassword((p) => !p)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                  aria-label={showStaffPassword ? 'Hide password' : 'Show password'}
                >
                  {showStaffPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || submittingOwner || submittingStaff}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
            >
              <KeyRound className="w-4 h-4" />
              {submittingStaff ? 'Signing in...' : 'Sign In as Sales Staff'}
            </button>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              Sales Staff accounts are created and managed exclusively by the Shop Owner inside Staff Management.
            </p>
          </form>
        )}

        <div className="flex items-center gap-2 text-xs text-slate-500 pt-2 border-t border-slate-100">
          <ShieldCheck className="w-4 h-4 text-teal-600 shrink-0" />
          <span>Currency: PKR · Timezone: Asia/Karachi · Date Format: DD-MM-YYYY</span>
        </div>
      </div>
    </div>
  );
}
