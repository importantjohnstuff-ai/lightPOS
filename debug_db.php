<?php
$db = new PDO('sqlite:data/database.sqlite');
$stmt = $db->query("SELECT count(*) FROM spatial_shelves");
if ($stmt) {
    echo "Count: " . $stmt->fetchColumn() . "\n";

    echo "Rows:\n";
    $rows = $db->query("SELECT * FROM spatial_shelves");
    foreach ($rows as $row) {
        print_r($row);
    }
} else {
    echo "Query failed or table empty.\n";
    print_r($db->errorInfo());
}
?>