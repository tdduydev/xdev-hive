import { QueryClientProvider } from "@tanstack/react-query";
import { Questions, SdlcProvider } from "@xdev-hive/sdlc-ui";
import { queryClient } from "@/lib/hub-query.tsx";
import { useDesktopSdlcEnv } from "@/lib/sdlc-env.tsx";

export function SdlcQuestionsScreen() {
  return (
    <QueryClientProvider client={queryClient}>
      <SdlcProvider env={useDesktopSdlcEnv()}>
        <Questions />
      </SdlcProvider>
    </QueryClientProvider>
  );
}
