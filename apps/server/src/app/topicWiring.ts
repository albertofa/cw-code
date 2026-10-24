import { PRS_TOPIC } from "@cw-code/shared/topics";
import type { ServerApp } from "./ServerApp.js";

export interface TopicWiring {
  resync(): void;
}

export function wireTopics(app: ServerApp): TopicWiring {
  const pushTrackedPrs = (clientId: string): void => {
    const services = app.currentServices();
    if (services) app.sendTo(clientId, "prs.tracked", services.prTracker.summaries());
  };

  app.topics.on(PRS_TOPIC, { onSubscribe: pushTrackedPrs });

  return {
    resync(): void {
      for (const clientId of app.topics.subscribers(PRS_TOPIC)) pushTrackedPrs(clientId);
    }
  };
}
