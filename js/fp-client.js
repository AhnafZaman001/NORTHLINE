/* =========================================================
   fp-client.js — shared Supabase client + auth helpers for
   the NORTHLINE form + admin pages.

   Login mechanism mirrors AXIOM (github.com/AhnafZaman001/AXIOM):
   email/password sign-in only, no self-serve signup. Accounts
   are created directly in the Supabase dashboard (Authentication
   -> Add user); the on_auth_user_created trigger in
   future_pathways_schema.sql then creates the matching
   public.app_users row (role defaults to 'student').
   ========================================================= */

window.FP = window.FP || {};

(function(){
  var SUPABASE_URL = "https://sqaehbedobvvannzqbow.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_iJ9vEuA-0mBCKYpLOOr2YQ_k4zy5rVb";

  if(typeof window.supabase === "undefined"){
    console.error("Supabase JS library did not load — check your internet connection.");
    return;
  }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  FP.client = client;

  FP.signIn = function(email, password){
    return client.auth.signInWithPassword({ email: email, password: password })
      .then(function(r){
        if(r.error) throw r.error;
        var session = r.data.session;
        if(session && session.access_token){
          fetch(SUPABASE_URL + "/functions/v1/send-login-alert", {
            method: "POST",
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: "Bearer " + session.access_token
            },
            keepalive: true
          }).catch(function(){});
        }
        return r.data;
      });
  };

  /** Sends a password-reset email. The link in that email lands on
   *  reset-password.html with a recovery session already active. */
  FP.requestPasswordReset = function(email){
    return client.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + "/reset-password.html"
    }).then(function(r){
      if(r.error) throw r.error;
      return r.data;
    });
  };

  /** Call on reset-password.html once the user has picked a new password. */
  FP.updatePassword = function(newPassword){
    return client.auth.updateUser({ password: newPassword }).then(function(r){
      if(r.error) throw r.error;
      return r.data;
    });
  };

  FP.signOut = function(){
    return client.auth.signOut().then(function(){
      window.location.href = "login.html";
    });
  };

  /** Returns {session, profile} for the signed-in user, or null if not signed in. */
  FP.getSessionAndProfile = function(){
    return client.auth.getSession().then(function(r){
      var session = r.data.session;
      if(!session) return null;
      return client.from("app_users").select("*").eq("id", session.user.id).single()
        .then(function(r2){
          if(r2.error){ console.error(r2.error); return null; }
          return { session: session, profile: r2.data };
        });
    });
  };

  /** Call at the top of any protected page. Redirects to login.html if not signed in. */
  FP.requireAuth = function(){
    return FP.getSessionAndProfile().then(function(result){
      if(!result){
        window.location.href = "login.html";
        return null;
      }
      return result;
    });
  };
})();
