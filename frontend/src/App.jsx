import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import FileUpload from './components/FileUpload'
import TextSummary from './components/TextSummary'
import CharacterImport from './components/CharacterImport'
import InterviewSettings from './components/InterviewSettings'
import Results from './components/Results'
import ModelSelector from './components/ModelSelector'
import ErrorBoundary from './components/ErrorBoundary'
import useProgressPolling from './hooks/useProgressPolling'
import { NOTIFICATION_SOUNDS } from './constants/notificationSounds'
import { isModelFree } from './utils/modelUtils'
import './App.css'
import './components/Results.css'

const MODEL_FETCH_DEBOUNCE_MS = 500
const CONFIG_SAVED_FLASH_MS = 2000
const TEST_STATUS_FLASH_MS = 5000
const FETCH_ERROR_FLASH_MS = 5000
const REQUEST_TIMEOUT_MS = 600000 // 10 minutes — multi-call pipeline needs more time
const DEFAULT_CONTEXT_LENGTH = 200000

function playNotificationSound(soundKey) {
  const sound = NOTIFICATION_SOUNDS[soundKey]
  if (!sound?.file) return
  try {
    const audio = new Audio(sound.file)
    audio.volume = 0.5
    audio.play().catch(() => {})
  } catch { /* ignore audio errors */ }
}

function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(() => {
    return localStorage.getItem('ai_api_base_url') || 'https://openrouter.ai/api/v1'
  })
  const [apiKey, setApiKey] = useState(() => {
    return localStorage.getItem('ai_api_key') || localStorage.getItem('openrouter_api_key') || ''
  })
  const [configSaved, setConfigSaved] = useState(false)
  const [selectedModel, setSelectedModel] = useState(() => {
    return localStorage.getItem('ai_selected_model') || 'google/gemini-flash-1.5-8b'
  })
  const [models, setModels] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState(null)
  const [mode, setMode] = useState('file')
  const [progressMessage, setProgressMessage] = useState('')
  const [testStatus, setTestStatus] = useState(null)
  const [fetchError, setFetchError] = useState('')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [partialResults, setPartialResults] = useState(null)
  const [interviewSettingsDirty, setInterviewSettingsDirty] = useState(false)
  const [notificationSound, setNotificationSound] = useState(() => {
    return localStorage.getItem('notification_sound') || 'none'
  })
  const fetchErrorTimeoutRef = useRef(null)
  const abortControllerRef = useRef(null)

  const handleNotificationSoundChange = useCallback((soundKey) => {
    setNotificationSound(soundKey)
    localStorage.setItem('notification_sound', soundKey)
  }, [])

  const handleSelectModel = useCallback((modelId) => {
    setSelectedModel(modelId)
    localStorage.setItem('ai_selected_model', modelId)
  }, [])

  const onProgressMessage = useCallback((msg) => setProgressMessage(msg), [])
  const onPartialResults = useCallback((partial) => setPartialResults(partial), [])
  const { start: startPolling, stop: stopPolling } = useProgressPolling(onProgressMessage, onPartialResults)

  const handleSaveConfig = () => {
    if (apiKey.trim() && apiBaseUrl.trim()) {
      localStorage.setItem('ai_api_key', apiKey)
      localStorage.setItem('ai_api_base_url', apiBaseUrl)
      localStorage.removeItem('openrouter_api_key')
      setConfigSaved(true)
      setTimeout(() => setConfigSaved(false), CONFIG_SAVED_FLASH_MS)
    }
  }

  const handleTestConnection = async () => {
    if (!apiKey.trim() || !apiBaseUrl.trim()) return
    setTestStatus('testing')
    try {
      const response = await axios.post('/api/process/test-connection', {
        apiBaseUrl: apiBaseUrl.trim(),
        apiKey: apiKey.trim()
      })
      if (response.data.success) {
        setTestStatus({ success: true, message: `Connected! ${response.data.modelCount} models available.` })
      } else {
        setTestStatus({ success: false, message: response.data.error || 'Connection failed' })
      }
    } catch (err) {
      setTestStatus({ success: false, message: err.response?.data?.error || err.message })
    }
    setTimeout(() => setTestStatus(null), TEST_STATUS_FLASH_MS)
  }

  // Fetch available models when API key or base URL changes
  useEffect(() => {
    const fetchModels = async () => {
      if (!apiKey.trim() || !apiBaseUrl.trim()) {
        if (fetchErrorTimeoutRef.current) {
          clearTimeout(fetchErrorTimeoutRef.current)
          fetchErrorTimeoutRef.current = null
        }
        setModels([])
        setFetchError('')
        return
      }

      setLoadingModels(true)
      try {
        const response = await axios.get('/api/process/models', {
          headers: {
            'x-api-key': apiKey,
            'x-api-base-url': apiBaseUrl.trim()
          }
        })
        const sortedModels = response.data.models.sort((a, b) => {
          const aFree = isModelFree(a)
          const bFree = isModelFree(b)
          if (aFree && !bFree) return -1
          if (!aFree && bFree) return 1
          return (b.context_length || 0) - (a.context_length || 0)
        })
        setModels(sortedModels)
        if (fetchErrorTimeoutRef.current) {
          clearTimeout(fetchErrorTimeoutRef.current)
          fetchErrorTimeoutRef.current = null
        }
        setFetchError('')

        const savedModel = localStorage.getItem('ai_selected_model')
        const savedExists = savedModel && sortedModels.some(m => m.id === savedModel)
        if (!savedExists) {
          const firstFree = sortedModels.find(isModelFree)
          if (firstFree) handleSelectModel(firstFree.id)
        }
      } catch (err) {
        console.warn('Failed to fetch models', err)
        setModels([])
        setFetchError('Failed to fetch models. Check your provider URL/API key and try again.')
        if (fetchErrorTimeoutRef.current) {
          clearTimeout(fetchErrorTimeoutRef.current)
        }
        fetchErrorTimeoutRef.current = setTimeout(() => {
          setFetchError('')
          fetchErrorTimeoutRef.current = null
        }, FETCH_ERROR_FLASH_MS)
      } finally {
        setLoadingModels(false)
      }
    }

    const debounce = setTimeout(fetchModels, MODEL_FETCH_DEBOUNCE_MS)
    return () => clearTimeout(debounce)
  }, [apiKey, apiBaseUrl])

  useEffect(() => {
    return () => {
      if (fetchErrorTimeoutRef.current) {
        clearTimeout(fetchErrorTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (!interviewSettingsDirty) return
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [interviewSettingsDirty])

  const handleModeChange = useCallback((nextMode) => {
    if (nextMode === mode) return
    if (interviewSettingsDirty && mode === 'settings') {
      const confirmed = window.confirm('You have unsaved interview settings changes. Switch mode and discard unsaved edits?')
      if (!confirmed) return
      setInterviewSettingsDirty(false)
    }
    setMode(nextMode)
  }, [interviewSettingsDirty, mode])

  // Elapsed timer while loading
  useEffect(() => {
    if (!loading) {
      setElapsedSeconds(0)
      return
    }
    const timer = setInterval(() => setElapsedSeconds(s => s + 1), 1000)
    return () => clearInterval(timer)
  }, [loading])

  const handleCancelProcess = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    stopPolling()
    setLoading(false)
    setPartialResults(null)
    setProgressMessage('')
    const cancelMessageByMode = {
      import: 'Import cancelled.',
      file: 'Upload cancelled.',
      summary: 'Summary cancelled.'
    }
    setError(cancelMessageByMode[mode] || 'Operation cancelled.')
  }, [mode, stopPolling])

  const handleProcess = async (formData) => {
    if (!apiKey.trim()) {
      setError('Please enter your API key')
      return
    }

    setLoading(true)
    setError('')
    setResults(null)
    setPartialResults(null)
    setProgressMessage(mode === 'import' ? 'Starting character import...' : 'Uploading file...')

    try {
      formData.append('apiKey', apiKey)
      formData.append('apiBaseUrl', apiBaseUrl.trim())
      formData.append('model', selectedModel)

      const selectedModelData = models.find(m => m.id === selectedModel)
      const contextLength = selectedModelData?.context_length || DEFAULT_CONTEXT_LENGTH
      formData.append('contextLength', contextLength)
      if (selectedModelData?.max_completion_tokens) {
        formData.append('maxCompletionTokens', selectedModelData.max_completion_tokens)
      }

      let endpoint;
      if (mode === 'file') endpoint = '/api/process/file';
      else if (mode === 'summary') endpoint = '/api/process/summary';
      else if (mode === 'import') {
        const subMode = formData.get('importMode')
        endpoint = subMode === 'url' ? '/api/process/url-import' : '/api/process/import'
      } else {
        throw new Error(`Invalid processing mode: ${mode}`)
      }

      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
      formData.append('sessionId', sessionId)

      // For import mode, start polling immediately (no large file upload)
      if (mode === 'import') {
        startPolling(sessionId)
      }

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      const response = await axios.post(endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: mode === 'import' ? 0 : REQUEST_TIMEOUT_MS, // import mode: no timeout (progress polling tracks activity)
        signal: abortController.signal,
        onUploadProgress: mode !== 'import' ? (progressEvent) => {
          const pct = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          setProgressMessage(`Uploading file... ${pct}%`)
          if (pct === 100) {
            setProgressMessage('Upload complete. Processing book...')
            startPolling(sessionId)
          }
        } : undefined
      })

      abortControllerRef.current = null

      stopPolling()

      if (!response.data) throw new Error('No data received from server')
      if (!response.data.characters || !Array.isArray(response.data.characters)) {
        throw new Error('Invalid response format: missing characters array')
      }

      setProgressMessage('Processing complete! Loading results...')
      setPartialResults(null)
      setResults(response.data)
      setLoading(false)
      playNotificationSound(notificationSound)
    } catch (err) {
      stopPolling()
      abortControllerRef.current = null
      setPartialResults(null)
      // If the user cancelled, handleCancelProcess already set the state
      if (axios.isCancel(err)) return
      const errorMessage = err.response?.data?.error || err.message || 'An error occurred'
      if (err.response?.status === 422 && err.response?.data?.manualFallbackRequired) {
        setError(`${errorMessage} Use the manual text input to paste the character's description instead.`)
      } else {
        setError(errorMessage)
      }
      setLoading(false)
    } finally {
      setProgressMessage('')
    }
  }

  const selectedModelData = models.find(m => m.id === selectedModel)

  return (
    <div className="container">
      <header>
        <h1>Project Braveheart</h1>
        <p>Generate character cards and lorebooks from various sources</p>
      </header>

      <div className="card">
        <h3>AI Provider Configuration</h3>

        <div className="form-group">
          <label className="form-label">Provider URL (OpenAI-compatible)</label>
          <input
            type="text"
            placeholder="https://openrouter.ai/api/v1"
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            className="full-width"
          />
          <small>
            Any OpenAI-compatible endpoint — OpenRouter, OpenAI, Ollama (http://localhost:11434/v1), LM Studio, Groq, etc.
          </small>
        </div>

        <div className="form-group">
          <label className="form-label">
            API Key {localStorage.getItem('ai_api_key') && <span className="saved-badge">Saved in cache</span>}
          </label>
          <div className="input-row">
            <input
              type="password"
              placeholder="Enter your API key..."
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setError('') }}
              className="flex-1"
            />
            <button
              onClick={handleSaveConfig}
              disabled={!apiKey.trim() || !apiBaseUrl.trim()}
              className={`save-btn ${configSaved ? 'saved' : 'secondary-btn'}`}
            >
              {configSaved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>

        <div className="form-group">
          <button
            onClick={handleTestConnection}
            disabled={!apiKey.trim() || !apiBaseUrl.trim() || testStatus === 'testing'}
            className="secondary-btn test-btn"
          >
            {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
          </button>
          {testStatus && testStatus !== 'testing' && (
            <div className={`status-message ${testStatus.success ? 'success' : 'error'}`}>
              {testStatus.message}
            </div>
          )}
        </div>

        <div>
          <label className="form-label">Model</label>
          {fetchError && <div className="status-message error">{fetchError}</div>}

          {loadingModels ? (
            <div className="placeholder-box">Loading models...</div>
          ) : models.length > 0 ? (
            <>
              <ModelSelector
                models={models}
                selectedModel={selectedModel}
                onSelectModel={handleSelectModel}
                disabled={!apiKey.trim()}
              />
              {selectedModelData && (
                <small className="context-info">
                  Context window: {(selectedModelData.context_length / 1000).toFixed(0)}K tokens
                  {selectedModelData.max_completion_tokens && (
                    <> | Max output: {(selectedModelData.max_completion_tokens / 1000).toFixed(0)}K tokens</>
                  )}
                  {' '}- Large books will be automatically chunked at chapter boundaries
                </small>
              )}
            </>
          ) : (
            <div className="placeholder-box">
              {apiKey.trim() ? 'No models found — check your provider URL and API key' : 'Enter API key to load models'}
            </div>
          )}
        </div>
      </div>

      <div className="card mode-selector">
        <button
          className={mode === 'file' ? 'primary-btn active' : 'secondary-btn'}
          onClick={() => handleModeChange('file')}
        >
          Upload Book
        </button>
        <button
          className={mode === 'summary' ? 'primary-btn active' : 'secondary-btn'}
          onClick={() => handleModeChange('summary')}
        >
          Paste Summary
        </button>
        <button
          className={mode === 'import' ? 'primary-btn active' : 'secondary-btn'}
          onClick={() => handleModeChange('import')}
        >
          Import Character
        </button>
        <button
          className={mode === 'settings' ? 'primary-btn active' : 'secondary-btn'}
          onClick={() => handleModeChange('settings')}
        >
          Settings
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading && (
        <>
          <div className="loading">
            <small>Elapsed: {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}</small>
            <br />
            <small>(this can take 5+ minutes)</small>
            <div className="spinner"></div>
            <p>{progressMessage || 'Processing... This may take a few minutes depending on book size.'}</p>
            <small className="keep-open-notice">Please keep this tab open</small>
            <button className="secondary-btn cancel-btn" onClick={handleCancelProcess}>
              Cancel
            </button>
          </div>
          {partialResults?.characters?.length > 0 && (
            <div className="card streaming-results">
              <h3>
                {partialResults.bookTitle || 'Characters'} — {partialResults.characters.length} loaded so far...
              </h3>
              <div className="character-grid">
                {partialResults.characters.map((char) => {
                  const charId = char.id || `${char.data?.name || 'character'}::${char.data?.character_version || 'main'}`
                  return (
                    <div key={charId} className="character-card streaming">
                      <div className="char-header">
                        <h4>{char.data?.name}</h4>
                        <span className="role-badge">
                          {char.characterType || 'Character'}
                        </span>
                      </div>
                      <p className="char-preview">
                        {char.data?.description?.substring(0, 150)}...
                      </p>
                      {char.data?.tags?.length > 0 && (
                        <div className="tag-list">
                          {char.data.tags.slice(0, 5).map((tag, tagIdx) => (
                            <span key={tagIdx} className="tag">{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {!loading && (
        <>
          {mode === 'file' ? (
            <FileUpload onUpload={handleProcess} contextLength={selectedModelData?.context_length || DEFAULT_CONTEXT_LENGTH} />
          ) : mode === 'summary' ? (
            <TextSummary onSubmit={handleProcess} />
          ) : mode === 'settings' ? (
            <InterviewSettings
              onDirtyChange={setInterviewSettingsDirty}
              notificationSound={notificationSound}
              onNotificationSoundChange={handleNotificationSoundChange}
            />
          ) : (
            <CharacterImport onSubmit={handleProcess} />
          )}
          {!results && (
            <div className="ready-message">
              <small>{
                mode === 'import'
                  ? 'Ready to import your character'
                  : mode === 'settings'
                    ? 'Manage interview settings'
                    : 'Ready to process your book'
              }</small>
            </div>
          )}
        </>
      )}

      {!loading && results && (
        <div key={results.sessionId || 'results'}>
          <div className="results-header">
            <small className="results-count">Results loaded - displaying {results.characters?.length || 0} characters</small>
            <button
              className="primary-btn new-upload-btn"
              onClick={() => { setResults(null); setError('') }}
            >
              Start Over
            </button>
          </div>
          <ErrorBoundary>
            <Results data={results} />
          </ErrorBoundary>
        </div>
      )}
    </div>
  )
}

export default App
