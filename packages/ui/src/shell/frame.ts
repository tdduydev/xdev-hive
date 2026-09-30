import { createContext, useContext } from "react";

/** True under ClientShell, whose top bar already shows the page title (pages then keep only their description). */
export const InShellContext = createContext(false);

export const useInShell = (): boolean => useContext(InShellContext);
