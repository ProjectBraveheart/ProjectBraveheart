import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import './CharacterImport.css'

const SERVICE_PRESETS = {
  kindroid: {
    label: 'Kindroid',
    url: 'https://api.kindroid.ai/v1',
  },
  characterai: {
    label: 'Character.AI',
    url: '',
  },
  other: {
    label: 'Other',
    url: '',
  },
}

const LOGIN_POLL_INTERVAL_MS = 2000
const LOGIN_MAX_WAIT_MS = 5 * 60 * 1000 + 15000

function CharacterImport({ onSubmit }) {
  // Sub-mode: 'interview' (existing) or 'url' (new)
  const [importMode, setImportMode] = useState(() => {
    return localStorage.getItem('import_mode') || 'interview'
  })

  // --- Interview mode state (existing) ---
  const [service, setService] = useState(() => {
    return localStorage.getItem('import_service') || 'kindroid'
  })
  const [serviceUrl, setServiceUrl] = useState(() => {
    return localStorage.getItem('import_service_url') || SERVICE_PRESETS.kindroid.url
  })
  const [serviceApiKey, setServiceApiKey] = useState(() => {
    return localStorage.getItem('import_service_api_key') || ''
  })
  const [characterId, setCharacterId] = useState(() => {
    return localStorage.getItem('import_character_id') || ''
  })
  const [coverImage, setCoverImage] = useState(null)

  // --- Character.AI interview state ---
  const [caiToken, setCaiToken] = useState(() => {
    return localStorage.getItem('import_cai_token') || ''
  })
  const [caiLoginLoading, setCaiLoginLoading] = useState(false)
  const [caiLoginError, setCaiLoginError] = useState('')
  const [caiLoginStatusText, setCaiLoginStatusText] = useState('')
  const [caiLoggedIn, setCaiLoggedIn] = useState(false)
  const isMountedRef = useRef(true)
  const janitorLoginControllerRef = useRef(null)
  const janitorLoginCancelledRef = useRef(false)
  const caiLoginControllerRef = useRef(null)
  const caiLoginCancelledRef = useRef(false)

  // --- URL import mode state (persisted to survive unmount during loading) ---
  const [characterUrl, setCharacterUrl] = useState(() => {
    return localStorage.getItem('url_import_character_url') || ''
  })
  const [detectedPlatform, setDetectedPlatform] = useState(null)
  const [authToken, setAuthToken] = useState(() => {
    return localStorage.getItem('url_import_auth_token') || ''
  })
  const [manualText, setManualText] = useState(() => {
    return localStorage.getItem('url_import_manual_text') || ''
  })
  const [showManualFallback, setShowManualFallback] = useState(false)
  const [platforms, setPlatforms] = useState(null)
  const [platformsLoading, setPlatformsLoading] = useState(false)
  const [platformsError, setPlatformsError] = useState('')
  const [urlCoverImage, setUrlCoverImage] = useState(null)
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [loginStatusText, setLoginStatusText] = useState('')
  const [janitorLoggedIn, setJanitorLoggedIn] = useState(false)

  const fetchPlatforms = useCallback(async () => {
    setPlatformsLoading(true)
    setPlatformsError('')
    try {
      const res = await axios.get('/api/process/platforms')
      setPlatforms(Array.isArray(res.data?.platforms) ? res.data.platforms : [])
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to load supported platforms.'
      setPlatformsError(msg)
    } finally {
      setPlatformsLoading(false)
    }
  }, [])

  // Fetch platform registry on mount
  useEffect(() => {
    fetchPlatforms()
  }, [fetchPlatforms])

  useEffect(() => {
    return () => {
      isMountedRef.current = false
      janitorLoginCancelledRef.current = true
      if (janitorLoginControllerRef.current) {
        janitorLoginControllerRef.current.abort()
        janitorLoginControllerRef.current = null
      }
      caiLoginCancelledRef.current = true
      if (caiLoginControllerRef.current) {
        caiLoginControllerRef.current.abort()
        caiLoginControllerRef.current = null
      }
    }
  }, [])

  // Detect platform from URL (client-side)
  useEffect(() => {
    if (!characterUrl.trim() || !platforms) {
      setDetectedPlatform(null)
      setShowManualFallback(false)
      return
    }

    try {
      const parsed = new URL(characterUrl.trim())
      const match = platforms.find(p => parsed.hostname.includes(p.hostPattern))

      if (match) {
        setDetectedPlatform(match)
        if (match.manualOnly) {
          setShowManualFallback(true)
        } else {
          setShowManualFallback(false)
        }
        // Load cached auth token for this platform
        const cached = localStorage.getItem(`url_import_token_${match.id}`)
        if (cached) setAuthToken(cached)
      } else {
        setDetectedPlatform(null)
        setShowManualFallback(true)
      }
    } catch {
      setDetectedPlatform(null)
      if (characterUrl.trim().length > 5) {
        setShowManualFallback(true)
      }
    }
  }, [characterUrl, platforms])

  // --- Interview mode handlers (existing) ---
  const handleServiceChange = (e) => {
    const value = e.target.value
    setService(value)
    localStorage.setItem('import_service', value)
    const preset = SERVICE_PRESETS[value]
    if (preset?.url) {
      setServiceUrl(preset.url)
      localStorage.setItem('import_service_url', preset.url)
    }
  }

  const handleServiceUrlChange = (e) => {
    const value = e.target.value
    setServiceUrl(value)
    localStorage.setItem('import_service_url', value)
  }

  const handleApiKeyChange = (e) => {
    const value = e.target.value
    setServiceApiKey(value)
    localStorage.setItem('import_service_api_key', value)
  }

  const handleCharacterIdChange = (e) => {
    let value = e.target.value
    // Auto-extract character ID from c.ai URL if pasted
    if (service === 'characterai' && value.includes('character.ai')) {
      const match = value.match(/character\.ai\/chat\/([a-zA-Z0-9_-]+)/)
      if (match) value = match[1]
    }
    setCharacterId(value)
    localStorage.setItem('import_character_id', value)
  }

  const handleCaiTokenChange = (e) => {
    const value = e.target.value
    setCaiToken(value)
    localStorage.setItem('import_cai_token', value)
  }

  // --- URL mode handlers ---
  const handleImportModeChange = (mode) => {
    setImportMode(mode)
    localStorage.setItem('import_mode', mode)
  }

  const handleCharacterUrlChange = (e) => {
    const value = e.target.value
    setCharacterUrl(value)
    localStorage.setItem('url_import_character_url', value)
  }

  const handleAuthTokenChange = (e) => {
    const value = e.target.value
    setAuthToken(value)
    localStorage.setItem('url_import_auth_token', value)
    if (detectedPlatform) {
      localStorage.setItem(`url_import_token_${detectedPlatform.id}`, value)
    }
  }

  const handleManualTextChange = (e) => {
    const value = e.target.value
    setManualText(value)
    localStorage.setItem('url_import_manual_text', value)
  }

  // --- JanitorAI login handler ---
  const handleJanitorLogin = async () => {
    if (janitorLoginControllerRef.current) {
      janitorLoginCancelledRef.current = true
      janitorLoginControllerRef.current.abort()
    }

    const controller = new AbortController()
    janitorLoginControllerRef.current = controller
    janitorLoginCancelledRef.current = false

    const isCancelled = () => (
      janitorLoginCancelledRef.current ||
      !isMountedRef.current ||
      controller.signal.aborted
    )

    const updateIfMounted = (updater) => {
      if (!isCancelled()) updater()
    }

    updateIfMounted(() => {
      setLoginLoading(true)
      setLoginError('')
      setJanitorLoggedIn(false)
      setLoginStatusText('Starting login session...')
    })

    try {
      const startRes = await axios.post('/api/process/janitor-login', undefined, {
        signal: controller.signal,
      })

      if (isCancelled()) return

      const loginSessionId = startRes.data?.sessionId
      if (!loginSessionId) {
        throw new Error('Login session could not be started')
      }

      updateIfMounted(() => {
        setLoginStatusText('Browser opened. Waiting for login confirmation...')
      })

      const startTime = Date.now()
      let finished = false
      while (!isCancelled() && !finished && (Date.now() - startTime) < LOGIN_MAX_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_INTERVAL_MS))
        if (isCancelled()) break

        updateIfMounted(() => {
          setLoginStatusText('Checking login status...')
        })

        const statusRes = await axios.get('/api/process/janitor-login-status', {
          params: { sessionId: loginSessionId },
          signal: controller.signal,
        })
        if (isCancelled()) break

        const status = statusRes.data?.status

        if (status === 'pending') {
          continue
        }

        if (status === 'completed') {
          finished = true
          updateIfMounted(() => {
            setJanitorLoggedIn(!!statusRes.data?.loggedIn)
            setLoginStatusText('Login completed.')
          })

          // Auto-populate auth token if captured during login
          if (statusRes.data?.token) {
            updateIfMounted(() => {
              setAuthToken(statusRes.data.token)
            })
            if (!isCancelled()) {
              localStorage.setItem('url_import_auth_token', statusRes.data.token)
              if (detectedPlatform) {
                localStorage.setItem(`url_import_token_${detectedPlatform.id}`, statusRes.data.token)
              }
            }
          }
          break
        }

        if (status === 'failed') {
          throw new Error(statusRes.data?.error || 'Login failed')
        }
      }

      if (!isCancelled() && !finished) {
        throw new Error('Login timed out. Please try again.')
      }
    } catch (err) {
      const wasCanceled = err?.code === 'ERR_CANCELED' || controller.signal.aborted
      if (wasCanceled || isCancelled()) {
        return
      }
      const msg = err.response?.data?.error || err.message
      updateIfMounted(() => {
        setLoginError(msg)
        setLoginStatusText('')
      })
    } finally {
      if (janitorLoginControllerRef.current === controller) {
        janitorLoginControllerRef.current = null
      }
      updateIfMounted(() => {
        setLoginLoading(false)
      })
    }
  }

  // --- Character.AI login handler ---
  const handleCAILogin = async () => {
    if (caiLoginControllerRef.current) {
      caiLoginCancelledRef.current = true
      caiLoginControllerRef.current.abort()
    }

    const controller = new AbortController()
    caiLoginControllerRef.current = controller
    caiLoginCancelledRef.current = false

    const isCancelled = () => (
      caiLoginCancelledRef.current ||
      !isMountedRef.current ||
      controller.signal.aborted
    )

    const updateIfMounted = (updater) => {
      if (!isCancelled()) updater()
    }

    updateIfMounted(() => {
      setCaiLoginLoading(true)
      setCaiLoginError('')
      setCaiLoggedIn(false)
      setCaiLoginStatusText('Starting login session...')
    })

    try {
      const startRes = await axios.post('/api/process/cai-login', undefined, {
        signal: controller.signal,
      })

      if (isCancelled()) return

      const loginSessionId = startRes.data?.sessionId
      if (!loginSessionId) {
        throw new Error('Login session could not be started')
      }

      updateIfMounted(() => {
        setCaiLoginStatusText('Browser opened. Log in to Character.AI...')
      })

      const startTime = Date.now()
      let finished = false
      while (!isCancelled() && !finished && (Date.now() - startTime) < LOGIN_MAX_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_INTERVAL_MS))
        if (isCancelled()) break

        updateIfMounted(() => {
          setCaiLoginStatusText('Checking login status...')
        })

        const statusRes = await axios.get('/api/process/cai-login-status', {
          params: { sessionId: loginSessionId },
          signal: controller.signal,
        })
        if (isCancelled()) break

        const status = statusRes.data?.status

        if (status === 'pending') {
          continue
        }

        if (status === 'completed') {
          finished = true
          updateIfMounted(() => {
            setCaiLoggedIn(!!statusRes.data?.loggedIn)
            setCaiLoginStatusText('Login completed.')
          })

          if (statusRes.data?.token) {
            updateIfMounted(() => {
              setCaiToken(statusRes.data.token)
            })
            if (!isCancelled()) {
              localStorage.setItem('import_cai_token', statusRes.data.token)
            }
          }
          break
        }

        if (status === 'failed') {
          throw new Error(statusRes.data?.error || 'Login failed')
        }
      }

      if (!isCancelled() && !finished) {
        throw new Error('Login timed out. Please try again.')
      }
    } catch (err) {
      const wasCanceled = err?.code === 'ERR_CANCELED' || controller.signal.aborted
      if (wasCanceled || isCancelled()) {
        return
      }
      const msg = err.response?.data?.error || err.message
      updateIfMounted(() => {
        setCaiLoginError(msg)
        setCaiLoginStatusText('')
      })
    } finally {
      if (caiLoginControllerRef.current === controller) {
        caiLoginControllerRef.current = null
      }
      updateIfMounted(() => {
        setCaiLoginLoading(false)
      })
    }
  }

  // --- Submit handlers ---
  const isKindroid = service === 'kindroid'
  const isCAI = service === 'characterai'
  const canSubmitInterview = isCAI
    ? caiToken.trim() && characterId.trim()
    : serviceUrl.trim() && serviceApiKey.trim() && characterId.trim()

  const canSubmitUrl = (characterUrl.trim() && !detectedPlatform?.manualOnly) || manualText.trim()

  const handleInterviewSubmit = () => {
    if (!canSubmitInterview) return
    const formData = new FormData()
    formData.append('importMode', 'interview')
    formData.append('importService', service)
    formData.append('characterId', characterId.trim())
    if (isCAI) {
      formData.append('caiToken', caiToken.trim())
    } else {
      formData.append('serviceUrl', serviceUrl.trim())
      formData.append('serviceApiKey', serviceApiKey.trim())
    }
    if (coverImage) formData.append('coverImage', coverImage)
    onSubmit(formData)
  }

  const handleUrlSubmit = () => {
    if (!canSubmitUrl) return
    const formData = new FormData()
    formData.append('importMode', 'url')

    if (characterUrl.trim()) {
      formData.append('characterUrl', characterUrl.trim())
    }
    if (authToken.trim()) {
      formData.append('authToken', authToken.trim())
    }
    if (manualText.trim()) {
      formData.append('manualText', manualText.trim())
    }
    if (urlCoverImage) {
      formData.append('coverImage', urlCoverImage)
    }

    onSubmit(formData)
  }

  // --- Render: Instructions helper ---
  const renderInstructions = (instructions) => {
    if (!instructions) return null
    return (
      <div className="import-notice">
        <strong>{instructions.title}</strong>
        <ol className="import-steps">
          {instructions.steps.map((step, i) => (
            <li key={i} dangerouslySetInnerHTML={{ __html: step }} />
          ))}
        </ol>
        {instructions.note && <em>{instructions.note}</em>}
      </div>
    )
  }

  return (
    <div className="card">
      <h3>Import Character</h3>

      {/* Sub-mode tabs */}
      <div className="import-tabs">
        <button
          className={`import-tab ${importMode === 'interview' ? 'active' : ''}`}
          onClick={() => handleImportModeChange('interview')}
        >
          Interview Character
        </button>
        <button
          className={`import-tab ${importMode === 'url' ? 'active' : ''}`}
          onClick={() => handleImportModeChange('url')}
        >
          Import from URL
        </button>
      </div>

      {/* ================================================================ */}
      {/* Interview mode (existing) */}
      {/* ================================================================ */}
      {importMode === 'interview' && (
        <>
          <p className="import-hint">
            Interview an AI character from an external service to generate a character card and lorebook.
            The character will be asked a series of questions about itself, its world, and its memories.
          </p>

          <div className="form-group">
            <label className="form-label">Service</label>
            <select value={service} onChange={handleServiceChange} className="import-select">
              {Object.entries(SERVICE_PRESETS).map(([key, preset]) => (
                <option key={key} value={key}>{preset.label}</option>
              ))}
            </select>
          </div>

          {/* Service-specific fields: Kindroid / Other */}
          {!isKindroid && !isCAI && (
            <div className="form-group">
              <label className="form-label">Service API URL</label>
              <input
                type="text"
                placeholder="https://api.example.com/v1"
                value={serviceUrl}
                onChange={handleServiceUrlChange}
                className="full-width"
              />
              <small>The base URL of the AI companion service API (must support /send-message and /chat-break endpoints)</small>
            </div>
          )}

          {!isCAI && (
            <div className="form-group">
              <label className="form-label">
                {isKindroid ? 'API Key' : 'Service API Key'}
                {localStorage.getItem('import_service_api_key') && <span className="saved-badge"> Saved in cache</span>}
              </label>
              <input
                type="password"
                placeholder={isKindroid ? 'Your Kindroid API key (starts with kn_)...' : 'Enter your service API key...'}
                value={serviceApiKey}
                onChange={handleApiKeyChange}
                className="full-width"
              />
            </div>
          )}

          {/* Service-specific fields: Character.AI */}
          {isCAI && (
            <div className="form-group">
              <label className="form-label">
                Auth Token
                {localStorage.getItem('import_cai_token') && <span className="saved-badge"> Saved in cache</span>}
              </label>
              <input
                type="password"
                placeholder="Your Character.AI auth token..."
                value={caiToken}
                onChange={handleCaiTokenChange}
                className="full-width"
              />
              <div className="cai-login-section">
                <button
                  className="secondary-btn cai-login-btn"
                  onClick={handleCAILogin}
                  disabled={caiLoginLoading}
                >
                  {caiLoginLoading ? 'Waiting for login...' : caiLoggedIn ? 'Re-login to Character.AI' : 'Login to Character.AI'}
                </button>
                {caiLoginLoading && (
                  <small className="login-hint">{caiLoginStatusText || 'A browser window will open. Log in and it will close automatically.'}</small>
                )}
                {!caiLoginLoading && caiLoginStatusText && !caiLoginError && (
                  <small className="login-hint">{caiLoginStatusText}</small>
                )}
                {caiLoginError && <span className="login-error">{caiLoginError}</span>}
                {caiLoggedIn && caiToken && <span className="login-success">Logged in — auth token captured</span>}
                {caiLoggedIn && !caiToken && <span className="login-success">Logged in — no token captured, try manual paste</span>}
              </div>
            </div>
          )}

          {/* Character ID — all services */}
          <div className="form-group">
            <label className="form-label">
              {isKindroid ? 'AI ID' : isCAI ? 'Character ID' : 'Character / AI ID'}
              {localStorage.getItem('import_character_id') && <span className="saved-badge"> Saved in cache</span>}
            </label>
            <input
              type="text"
              placeholder={isKindroid
                ? 'Your character\'s AI ID...'
                : isCAI
                  ? 'Character ID or character.ai/chat/... URL'
                  : 'Enter the character\'s AI ID...'}
              value={characterId}
              onChange={handleCharacterIdChange}
              className="full-width"
            />
            {isCAI && (
              <small>Find the Character ID in the URL: character.ai/chat/<strong>characterId</strong></small>
            )}
          </div>

          <div className="cover-section">
            <label className="cover-section-label">Character Image (recommended)</label>
            <div className="custom-cover">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => e.target.files?.[0] && setCoverImage(e.target.files[0])}
              />
              {coverImage && <p className="selected-cover">Selected: {coverImage.name}</p>}
            </div>
            <small>Save the character's profile picture from the service and upload it here. Most service APIs don't support image download.</small>
          </div>

          {isKindroid && (
            <div className="import-notice">
              <strong>Setup:</strong> In Kindroid, go to your character's settings
              → <em>General</em>:
              <ol className="import-steps">
                <li>
                  Scroll down to <em>Long term memory controls</em> and turn
                  off <em>Memory consolidation</em> and <em>Memory recall</em>.
                </li>
                <li>
                  Scroll down to <em>API &amp; advanced integrations</em> to find
                  your <em>API Key</em> and <em>AI ID</em> — copy them into the fields above.
                </li>
                <li>Hit <em>Save</em> before leaving the settings page.</li>
                <li>Re-enable memory settings after the import completes.</li>
              </ol>
              The interview will send messages to your character's chat. A chat-break will be
              performed afterward to reset context, but messages will remain in the chat history.
            </div>
          )}

          {isCAI && (
            <div className="import-notice">
              <strong>How it works:</strong>
              <ol className="import-steps">
                <li>Click <em>Login to Character.AI</em> above to open a browser window and sign in.</li>
                <li>After login, your auth token will be captured automatically.</li>
                <li>Find the Character ID in the URL: character.ai/chat/<strong>characterId</strong></li>
                <li>The interview will create a new conversation and ask the character about itself.</li>
              </ol>
              Character.AI responses may be filtered or shortened by c.ai's safety system.
              The interview works best with characters that have detailed definitions.
              Your existing chat history with the character is preserved.
            </div>
          )}

          <button className="primary-btn process-btn" onClick={handleInterviewSubmit} disabled={!canSubmitInterview}>
            Interview Character
          </button>
        </>
      )}

      {/* ================================================================ */}
      {/* URL Import mode (new) */}
      {/* ================================================================ */}
      {importMode === 'url' && (
        <>
          <p className="import-hint">
            Paste a character URL from JanitorAI, Character.AI, SpicyChat, or other platforms.
            The app will try to fetch character data automatically. If that's not possible,
            you can paste the character's description manually.
          </p>

          {platformsLoading && (
            <div className="import-notice platform-status-notice">Loading supported platforms...</div>
          )}

          {platformsError && (
            <div className="import-notice platform-status-notice error">
              Could not load platform registry: {platformsError}
              <button
                type="button"
                className="secondary-btn platform-retry-btn"
                onClick={fetchPlatforms}
                disabled={platformsLoading}
              >
                Retry
              </button>
            </div>
          )}

          {/* URL input */}
          <div className="form-group">
            <label className="form-label">Character URL</label>
            <input
              type="text"
              placeholder="https://janitorai.com/characters/... or any supported platform URL"
              value={characterUrl}
              onChange={handleCharacterUrlChange}
              className="full-width"
            />
            {/* Platform detection badge */}
            {characterUrl.trim() && (
              <div className="platform-detection">
                {detectedPlatform ? (
                  <span className={`platform-badge ${detectedPlatform.manualOnly ? 'manual' : 'detected'}`}>
                    {detectedPlatform.label} detected
                    {detectedPlatform.manualOnly && ' (manual input required)'}
                  </span>
                ) : (
                  <span className="platform-badge unrecognized">
                    Unrecognized platform — use manual input below
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Auth token input — shown when platform has auth instructions and isn't manual-only */}
          {detectedPlatform && detectedPlatform.authInstructions && !detectedPlatform.manualOnly && (
            <div className="form-group">
              <label className="form-label">
                {detectedPlatform.label} Auth Token
                {!detectedPlatform.requiresAuth && <span className="optional-badge"> (optional)</span>}
                {localStorage.getItem(`url_import_token_${detectedPlatform.id}`) && (
                  <span className="saved-badge"> Saved in cache</span>
                )}
              </label>
              <input
                type="password"
                placeholder={detectedPlatform.requiresAuth
                  ? `Paste your ${detectedPlatform.label} auth token...`
                  : `Optional — only needed for private characters`}
                value={authToken}
                onChange={handleAuthTokenChange}
                className="full-width"
              />
              {detectedPlatform.id === 'janitorai' && (
                <div className="janitor-login-section">
                  <button
                    className="secondary-btn janitor-login-btn"
                    onClick={handleJanitorLogin}
                    disabled={loginLoading}
                  >
                    {loginLoading ? 'Waiting for login...' : janitorLoggedIn ? 'Re-login to JanitorAI' : 'Login to JanitorAI'}
                  </button>
                  {loginLoading && (
                    <small className="login-hint">{loginStatusText || 'A browser window will open. Log in and it will close automatically.'}</small>
                  )}
                  {!loginLoading && loginStatusText && !loginError && (
                    <small className="login-hint">{loginStatusText}</small>
                  )}
                  {loginError && <span className="login-error">{loginError}</span>}
                  {janitorLoggedIn && authToken && <span className="login-success">Logged in — auth token captured</span>}
                  {janitorLoggedIn && !authToken && <span className="login-success">Logged in — no token captured, try manual paste</span>}
                </div>
              )}
              {renderInstructions(detectedPlatform.authInstructions)}
            </div>
          )}

          {/* Manual-only platform instructions */}
          {detectedPlatform?.manualOnly && renderInstructions(detectedPlatform.manualInstructions)}

          {/* Manual fallback textarea */}
          {(showManualFallback || !characterUrl.trim()) && (
            <div className="form-group">
              <label className="form-label">
                Character Description {characterUrl.trim() ? '(manual fallback)' : '(paste character info)'}
              </label>
              <textarea
                placeholder="Paste the character's description, personality, scenario, greeting message, and any other text from the character's page. The more detail you include, the better the generated card will be."
                value={manualText}
                onChange={handleManualTextChange}
                className="full-width manual-text-input"
                rows={8}
              />
              {manualText.trim() && (
                <small>{manualText.trim().length.toLocaleString()} characters</small>
              )}
            </div>
          )}

          {/* Cover image */}
          <div className="cover-section">
            <label className="cover-section-label">Character Image (recommended)</label>
            <div className="custom-cover">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => e.target.files?.[0] && setUrlCoverImage(e.target.files[0])}
              />
              {urlCoverImage && <p className="selected-cover">Selected: {urlCoverImage.name}</p>}
            </div>
            <small>Upload the character's profile picture. If the platform provides an avatar URL, it will be downloaded automatically.</small>
          </div>

          <button className="primary-btn process-btn" onClick={handleUrlSubmit} disabled={!canSubmitUrl}>
            Import Character
          </button>
        </>
      )}
    </div>
  )
}

export default CharacterImport
