// The director page starts a just-published beat's narration by itself. When the beat has dice, the stream plays
// the dice moment first, so the start waits for the moment's length; a newer publish or a closed page cancels the wait.
export function createNarrationWait(start: (beatId: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() {
    clearTimeout(timer);
    timer = undefined;
  }
  return {
    published(beatId: string, voiced: boolean, waitMs = 0) {
      cancel();
      if (!voiced) return;
      if (waitMs <= 0) {
        start(beatId);
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        start(beatId);
      }, waitMs);
    },
    dispose: cancel,
  };
}
