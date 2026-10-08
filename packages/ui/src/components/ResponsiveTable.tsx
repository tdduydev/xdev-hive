import { Children, Fragment, cloneElement, createContext, isValidElement, useContext, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { cn } from "cn";

const Labels = createContext<ReactNode[]>([]);

function flatten(children: ReactNode, prefix = ""): ReactElement<ComponentProps<"td">>[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<ComponentProps<"td">>(child)) return [];
    return child.type === Fragment ? flatten(child.props.children, `${prefix}${child.key}/`) : [cloneElement(child, { key: `${prefix}${child.key}` })];
  });
}

function headers(children: ReactNode): ReactNode[] {
  return flatten(children).flatMap((child) => child.type === TableHead ? [child.props.children] : headers(child.props.children));
}

/** The same rows and controls stay mounted across the breakpoint, preserving selection and focus. */
export function ResponsiveTable({ children, ...props }: ComponentProps<typeof Table>) {
  const header = flatten(children).find((child) => child.type === TableHeader);
  return (
    <Labels.Provider value={headers(header?.props.children)}>
      <ResponsiveTableFrame>
        <Table role="table" {...props}>{children}</Table>
      </ResponsiveTableFrame>
    </Labels.Provider>
  );
}

export function ResponsiveTableRow({ children, ...props }: ComponentProps<typeof TableRow>) {
  const labels = useContext(Labels);
  let column = 0;
  return (
    <TableRow role="row" tabIndex={props.onClick ? 0 : undefined} onKeyDown={props.onClick ? (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.currentTarget.click(); } } : undefined} {...props}>
      {flatten(children).map((cell, index) => {
        const label = labels[column];
        column += cell.props.colSpan ?? 1;
        return cell.type === TableCell && !cell.props.colSpan ? (
          <TableCell role="cell" key={cell.key ?? index} {...cell.props} data-card-actions={!label || undefined}>
            <ResponsiveCellLabel ariaHidden>{label}</ResponsiveCellLabel>
            <div data-card-value>{cell.props.children}</div>
          </TableCell>
        ) : cell;
      })}
    </TableRow>
  );
}

/** Also accepts grid rows: mark their header, row, cells and primary cell with data-card-* attributes. */
export function ResponsiveTableFrame({ className, enabled = true, ...props }: ComponentProps<"div"> & { enabled?: boolean }) {
  return <div data-responsive-table={enabled || undefined} className={cn("min-w-0", className)} {...props} />;
}

export function ResponsiveCellLabel({ children, ariaHidden }: { children: ReactNode; ariaHidden?: boolean }) {
  return children ? <span data-card-label aria-hidden={ariaHidden}>{children}</span> : null;
}

export function ResponsiveGridRow({ labels, primary = 0, children, ...props }: ComponentProps<"div"> & { labels: ReactNode[]; primary?: number }) {
  return (
    <div data-card-row {...props}>
      {flatten(children).map((cell, index) => (
        <div key={cell.key ?? index} data-card-cell data-card-primary={index === primary || undefined} data-card-actions={index !== primary && !labels[index] || undefined} className="contents">
          <ResponsiveCellLabel>{labels[index]}</ResponsiveCellLabel>
          <div data-card-value>{cell}</div>
        </div>
      ))}
    </div>
  );
}
