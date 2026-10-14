// Supabase Email/Password Authentication
// Replaces Google OAuth with secure email/password auth

const AUTH = {
  supabaseUrl: null,
  supabaseKey: null,
  session: null,
  user: null,

  async init() {
    // Get keys from environment or server endpoint
    try {
      let env = window.APP_CONFIG || {};
      try {
        const res = await fetch('/api/env');
        const e2 = res.ok ? await res.json() : {};
        if (e2.SUPABASE_URL && e2.SUPABASE_ANON_KEY) env = e2;
      } catch (_) { /* static hosting: use js/config.js */ }
      this.supabaseUrl = env.SUPABASE_URL;
      this.supabaseKey = env.SUPABASE_ANON_KEY;
      if (!this.supabaseUrl || !this.supabaseKey) throw new Error('Missing Supabase keys');
    } catch (e) {
      console.error('Failed to load Supabase config:', e);
      throw e;
    }
  },

  // Sign up new user
  async signUp(email, password, name) {
    try {
      const res = await fetch(`${this.supabaseUrl}/auth/v1/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': this.supabaseKey },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.msg || data.error_description || data.message || 'Sign up failed');
      }

      // With "Confirm email" on, Supabase returns the user but no session
      const needsConfirmation = !data.access_token && !data.session;
      if (!needsConfirmation) {
        this._setSession(data.session || data);
        this.user = data.user ? { id: data.user.id, email } : { id: data.id, email };
        this._markLoggedIn();
      }

      return { success: true, user: data.user || data, needsConfirmation };
    } catch (e) {
      console.error('Sign up error:', e);
      throw e;
    }
  },

  // Sign in existing user
  async signIn(email, password) {
    try {
      const res = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': this.supabaseKey },
        body: JSON.stringify({ email, password })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error_description || err.msg || err.message || 'Sign in failed');
      }

      const data = await res.json();
      this._setSession(data);
      this.user = { id: data.user.id, email };
      this._markLoggedIn();

      // Load user profile
      const profile = await this.getUserProfile(data.user.id);
      if (profile) {
        userProfile.name = profile.name || email;
        userProfile.handle = profile.handle || '@' + email.split('@')[0];
      }

      return { success: true, user: this.user };
    } catch (e) {
      console.error('Sign in error:', e);
      throw e;
    }
  },

  // Create user profile after sign up
  async createUserProfile(email, name) {
    if (!this.user?.id) return;

    try {
      const handle = '@' + email.split('@')[0];
      await fetch(`${this.supabaseUrl}/rest/v1/user_profiles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.supabaseKey,
          'Authorization': `Bearer ${this.session.access_token}`
        },
        body: JSON.stringify({
          id: this.user.id,
          email,
          name: name || email,
          handle: handle,
          theme: 'light'
        })
      });
    } catch (e) {
      console.error('Failed to create user profile:', e);
    }
  },

  // Get user profile
  async getUserProfile(userId) {
    try {
      const res = await fetch(
        `${this.supabaseUrl}/rest/v1/user_profiles?id=eq.${userId}&select=*`,
        {
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.session.access_token}`
          }
        }
      );

      if (!res.ok) return null;
      const data = await res.json();
      return data[0] || null;
    } catch (e) {
      console.error('Failed to get user profile:', e);
      return null;
    }
  },

  // Update user profile
  async updateUserProfile(updates) {
    if (!this.user?.id) throw new Error('Not logged in');

    try {
      const res = await fetch(
        `${this.supabaseUrl}/rest/v1/user_profiles?id=eq.${this.user.id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.session.access_token}`
          },
          body: JSON.stringify(updates)
        }
      );

      if (!res.ok) throw new Error('Failed to update profile');
      return await res.json();
    } catch (e) {
      console.error('Update profile error:', e);
      throw e;
    }
  },

  // Refresh access token
  async refreshToken() {
    if (!this.session?.refresh_token) return false;

    try {
      const res = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': this.supabaseKey },
        body: JSON.stringify({ refresh_token: this.session.refresh_token })
      });

      if (!res.ok) {
        await this.logout();
        return false;
      }

      const data = await res.json();
      this._setSession(data);
      if (data.user?.id) this.user = { id: data.user.id, email: data.user.email || this.user?.email };
      return true;
    } catch (e) {
      console.error('Token refresh failed:', e);
      return false;
    }
  },

  // Store session (with absolute expiry) in memory and localStorage
  _setSession(data) {
    const s = { ...data };
    s.expires_at = s.expires_at ? s.expires_at * 1000 : Date.now() + (s.expires_in || 3600) * 1000;
    this.session = s;
    localStorage.setItem('supabase_session', JSON.stringify(s));
  },

  _markLoggedIn() {
    if (typeof userProfile === 'undefined' || !this.user) return;
    userProfile.isLoggedIn = true;
    userProfile.email = this.user.email;
    if (!userProfile.name) userProfile.name = this.user.email;
  },

  // Refresh the token shortly before it expires
  async ensureFresh() {
    if (!this.session) return false;
    if (Date.now() < (this.session.expires_at || 0) - 60000) return true;
    return this.refreshToken();
  },

  // Sign out (also revokes the session on the server)
  async logout() {
    const token = this.session?.access_token;
    this.session = null;
    this.user = null;
    localStorage.removeItem('supabase_session');
    if (typeof userProfile !== 'undefined') {
      userProfile.isLoggedIn = false;
    }
    if (token && this.supabaseUrl) {
      fetch(`${this.supabaseUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: this.supabaseKey, Authorization: `Bearer ${token}` }
      }).catch(() => {});
    }
  },

  // Restore session from localStorage
  async restoreSession() {
    const saved = localStorage.getItem('supabase_session');
    if (!saved) return false;

    try {
      this.session = JSON.parse(saved);
      if (!this.session?.access_token || !this.session.user?.id) throw new Error('Invalid saved session');
      this.user = { id: this.session.user.id, email: this.session.user.email };

      if (!(await this.ensureFresh())) return false;
      this._markLoggedIn();
      return true;
    } catch (e) {
      console.error('Failed to restore session:', e);
      return false;
    }
  },

  // Get auth headers for API calls
  getHeaders() {
    if (!this.session?.access_token) return {};
    return {
      'Authorization': `Bearer ${this.session.access_token}`,
      'apikey': this.supabaseKey
    };
  },

  // Send a password-reset email
  async requestPasswordReset(email) {
    const res = await fetch(`${this.supabaseUrl}/auth/v1/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.supabaseKey },
      body: JSON.stringify({ email })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.msg || err.error_description || err.message || 'Could not send reset email');
    }
    return true;
  },

  // Read a recovery token from the URL hash (set by the emailed link), then clear it
  consumeRecoveryToken() {
    const params = new URLSearchParams((typeof location !== 'undefined' ? location.hash : '').replace(/^#/, ''));
    if (params.get('type') !== 'recovery' || !params.get('access_token')) return null;
    const token = params.get('access_token');
    if (typeof history !== 'undefined') history.replaceState(null, '', location.pathname + location.search);
    return token;
  },

  // Set a new password using the recovery token
  async updatePassword(token, password) {
    if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
    const res = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', apikey: this.supabaseKey, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ password })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.msg || err.error_description || err.message || 'Could not update password');
    }
    return true;
  },

  // Check if currently authenticated
  isAuthenticated() {
    return !!this.session?.access_token && !!this.user?.id;
  }
};

if (typeof module !== 'undefined') module.exports = AUTH;

