/** When a trip last started or sent a fix. Lets background jobs stay quiet (and the database asleep) when nothing is happening. */
export const markActivity = (holder: { activityAt?: number }) => { holder.activityAt = Date.now(); };
