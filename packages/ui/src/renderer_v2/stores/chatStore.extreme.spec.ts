import { ChatStore, type ChatMessage } from './ChatStore'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const createAssistantMessage = (
  id: string,
  overrides?: Partial<ChatMessage>,
): ChatMessage => ({
  id,
  role: 'assistant',
  type: 'text',
  content: '',
  timestamp: 1,
  streaming: true,
  ...overrides,
})

const getActiveSessionOrThrow = (store: ChatStore) => {
  const session = store.activeSession
  assertCondition(session, 'expected an active session to exist')
  return session!
}

runCase('ADD_MESSAGE increments renderListVersion for the active session', () => {
  const store = new ChatStore()
  store.createSession('Spec Chat') // sessions are created explicitly now (no auto default)
  const session = getActiveSessionOrThrow(store)
  const previousVersion = session.renderListVersion

  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-1', { content: 'hello' }),
  })

  assertEqual(
    session.renderListVersion,
    previousVersion + 1,
    'adding a visible row should invalidate the render list memo',
  )
})

runCase('APPEND_CONTENT keeps renderListVersion stable during streaming', () => {
  const store = new ChatStore()
  store.createSession('Spec Chat') // sessions are created explicitly now (no auto default)
  const session = getActiveSessionOrThrow(store)

  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-1', { content: 'a' }),
  })
  const versionAfterAdd = session.renderListVersion

  for (let index = 0; index < 32; index += 1) {
    store.handleUiUpdate({
      type: 'APPEND_CONTENT',
      sessionId: session.id,
      messageId: 'assistant-1',
      content: String(index),
    })
  }

  assertEqual(
    session.renderListVersion,
    versionAfterAdd,
    'stream deltas should not invalidate the structural render model',
  )
})

runCase('UPDATE_MESSAGE invalidates renderListVersion when streaming status changes', () => {
  const store = new ChatStore()
  store.createSession('Spec Chat') // sessions are created explicitly now (no auto default)
  const session = getActiveSessionOrThrow(store)

  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-1', { content: 'hello' }),
  })
  const versionAfterAdd = session.renderListVersion

  store.handleUiUpdate({
    type: 'UPDATE_MESSAGE',
    sessionId: session.id,
    messageId: 'assistant-1',
    patch: { streaming: false },
  })

  assertEqual(
    session.renderListVersion,
    versionAfterAdd + 1,
    'message update patches should invalidate the render model when row state changes',
  )
})

runCase('REMOVE_MESSAGE invalidates renderListVersion after deleting a visible row', () => {
  const store = new ChatStore()
  store.createSession('Spec Chat') // sessions are created explicitly now (no auto default)
  const session = getActiveSessionOrThrow(store)

  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-1', { content: 'hello' }),
  })
  const versionAfterAdd = session.renderListVersion

  store.handleUiUpdate({
    type: 'REMOVE_MESSAGE',
    sessionId: session.id,
    messageId: 'assistant-1',
  })

  assertEqual(
    session.renderListVersion,
    versionAfterAdd + 1,
    'removing a row should invalidate render-driven memoized state',
  )
  assertEqual(
    session.messageIds.length,
    0,
    'removing a row should drop it from the visible message id list',
  )
})

runCase('ROLLBACK invalidates renderListVersion after pruning trailing messages', () => {
  const store = new ChatStore()
  store.createSession('Spec Chat') // sessions are created explicitly now (no auto default)
  const session = getActiveSessionOrThrow(store)

  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-1', {
      content: 'first',
      backendMessageId: 'backend-1',
      streaming: false,
    }),
  })
  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-2', {
      content: 'second',
      backendMessageId: 'backend-2',
      streaming: false,
    }),
  })
  const versionBeforeRollback = session.renderListVersion

  store.handleUiUpdate({
    type: 'ROLLBACK',
    sessionId: session.id,
    messageId: 'backend-2',
  })

  assertEqual(
    session.renderListVersion,
    versionBeforeRollback + 1,
    'rollback should invalidate the render model after dropping rows',
  )
  assertEqual(
    session.messageIds.length,
    1,
    'rollback should prune messages from the rollback target onward',
  )
})

console.log('All ChatStore extreme tests passed.')
