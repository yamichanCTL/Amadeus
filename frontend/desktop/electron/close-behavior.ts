export function closeAction(keepRunningInBackground: boolean): 'hide' | 'quit' {
  return keepRunningInBackground ? 'hide' : 'quit'
}
