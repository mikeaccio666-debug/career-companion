import {createContext,useContext,type HTMLAttributes} from 'react';
export const StudentShellContext=createContext(false);
/** Standalone domain previews keep their existing navigation. Inside the app,
 * the shared shell owns navigation and logout, avoiding two competing menus. */
export function StudentPageNavigation(props:HTMLAttributes<HTMLElement>){
 const embedded=useContext(StudentShellContext);
 return embedded?null:<nav {...props}/>;
}
export function StandaloneStudentHeader(props:HTMLAttributes<HTMLElement>){
 const embedded=useContext(StudentShellContext);
 return embedded?null:<header {...props}/>;
}
