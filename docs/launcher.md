# The command launcher

Press **Ctrl + K** (**⌘ K** on a Mac) anywhere in the console, or choose **Search** in the top bar, to open the launcher. A few letters find a page, a virtual machine, a host, cluster or datastore, a saved view or something to
create, and **Enter** goes there.

- **Nothing typed:** the commands used lately come first (marked *Recent*, at most five, remembered by the browser), then the pages.
- **Typing:** every word typed has to be found in the title, the detail or the keywords of a command. Words at the start of a word of the title count most, so `cap` finds *Capacity* before anything that merely contains the letters. Among equals the shorter title wins.
  At most twelve results are shown.
- **Keys:** ↑ and ↓ move the choice (they wrap round), Ctrl + Home and Ctrl + End jump to the first and last (plain Home and End still move the cursor in the field), **Enter** runs it, **Esc** closes the box. The mouse works too.

## What it can do

| Group | Commands |
|---|---|
| Go to | Overview, Virtual machines, Infrastructure, Connections, Monitor (and its tabs: Performance, Connection alerts, Task history, Audit history), Alert rules, Schedules, Capacity, Users, Platform health |
| Do | Add a connection, New alert rule, New webhook, New schedule, Save the current inventory view…, Export the inventory to CSV, Refresh the data, My sessions, Sign out |
| Views | Your saved inventory views: choosing one applies it |
| Infrastructure | Hosts, clusters, datastores, networks and datacenters, by name: choosing one opens it in the Infrastructure page |
| Virtual machines | By name: choosing one opens its detail |

## What it does not do

The launcher changes nothing by itself. A command takes you to a page, or opens the same dialog you would have opened by hand (the new-schedule dialog, the save-view dialog), so every confirmation, every
check and every audit record stays exactly where it was. There is no command that powers a machine on or off, deletes anything or changes a setting.

## Permissions

A command you may not use is **not offered**: someone without `connection.view` is not offered Connections, without `identity.manage` not Users, without `audit.view` not Audit history, and without
`alert.manage`, `schedule.manage` or `connection.manage` none of the matching *New …* commands. An auditor therefore sees the pages and the read-only actions only. This only saves a dead end: the server
still decides, and refuses what a person may not do whichever way they got there.

## What is kept, and where

Only the list of recently used command ids, in the browser's local storage under `nuvrion.launcher.recent`. It holds no names, no machine names and nothing from the server; a browser that blocks storage just
forgets the list.

## Accessibility

The box is a dialog with a labelled search field (an ARIA combobox) controlling a list of options; the choice is announced as it moves (`aria-activedescendant`) and the number of results is announced when
they change. Focus returns to where it was when the box closes. It is covered by the axe-core checks (empty, with results, and with nothing found).
